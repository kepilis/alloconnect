// alloconnect-helper.exe — помощник alloconnect для Windows.
//
//   exclude <pid>   — весь звук компьютера, КРОМЕ процесса <pid> и его детей (сам alloconnect) → PCM в stdout
//   window  <hwnd>  — только звук приложения, которому принадлежит окно <hwnd> → PCM в stdout
//   watch   <hwnd>  — состояние окна (min | normal | gone) и его прямоугольник ("rect x y w h") в stdout
//   restore <hwnd>  — развернуть свёрнутое окно, не забирая фокус
//   duck    <pid>   — приглушение других программ: читает из stdin "level 0.35" (1 = как было);
//                     при закрытии stdin возвращает громкость на место
//   keys    <vk,..> — push-to-talk: "down <vk>" / "up <vk>" при нажатии/отпускании (глобально)
//   fg      x       — полноэкранное окно на переднем плане (во что играет): "fg 1\t<exe>\t<title>" / "fg 0"
//   apply/swap      — установка обновления / откат после выхода alloconnect (см. runApply)
//   input   <pid>   — удалённое управление: мышь, клавиатура (SendInput) и виртуальный геймпад Xbox 360
//                     (нужен драйвер ViGEmBus). Команды построчно из stdin.
//
// PCM: 48000 Гц, 2 канала, int16 little-endian. В stderr: "OK" после старта или "ERR <текст>".
// Требуется Windows 10 2004 (build 19041) или новее для захвата звука.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <dwmapi.h>
#include <tlhelp32.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <string>
#include <vector>
#include <map>
#include <set>

#include <shellapi.h>
#include <ViGEm/Client.h>

// --- Определения из audioclientactivationparams.h (нет в mingw) ---
enum AUDIOCLIENT_ACTIVATION_TYPE_ { ACT_DEFAULT = 0, ACT_PROCESS_LOOPBACK = 1 };
enum PROCESS_LOOPBACK_MODE_ { LOOPBACK_INCLUDE_TREE = 0, LOOPBACK_EXCLUDE_TREE = 1 };
struct PROCESS_LOOPBACK_PARAMS_ { DWORD TargetProcessId; DWORD ProcessLoopbackMode; };
struct ACTIVATION_PARAMS_ { DWORD ActivationType; PROCESS_LOOPBACK_PARAMS_ ProcessLoopbackParams; };
static const wchar_t *PROCESS_LOOPBACK_DEVICE = L"VAD\\Process_Loopback";

static const IID kIID_IUnknown   = {0x00000000, 0x0000, 0x0000, {0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46}};
static const IID kIID_IAgile     = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0,0xff,0xee,0x64,0xca,0x8f,0x5b,0x90}};
static const IID kIID_Handler    = {0x41D949AB, 0x9862, 0x444A, {0x80,0xF6,0xC2,0x61,0x33,0x4D,0xA5,0xEB}};
static const IID kIID_AudioClient= {0x1CB9AD4C, 0xDBFA, 0x4c32, {0xB1,0x78,0xC2,0xF5,0x68,0xA7,0x03,0xB2}};
static const IID kIID_Capture    = {0xC8ADBD64, 0xE71E, 0x48a0, {0xA4,0xDE,0x18,0x5C,0x39,0x5C,0xD3,0x17}};
static const CLSID kCLSID_MMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E,0x3D,0xC4,0x57,0x92,0x91,0x69,0x2E}};
static const IID kIID_IMMDeviceEnumerator   = {0xA95664D2, 0x9614, 0x4F35, {0xA7,0x46,0xDE,0x8D,0xB6,0x36,0x17,0xE6}};
static const IID kIID_IAudioSessionManager2 = {0x77AA99A0, 0x1BD6, 0x484F, {0x8B,0xC7,0x2C,0x65,0x4C,0x9A,0x9B,0x6F}};
static const IID kIID_IAudioSessionControl2 = {0xbfb7ff88, 0x7239, 0x4fc9, {0x8f,0xa2,0x07,0xc9,0x50,0xbe,0x9c,0x6d}};
static const IID kIID_ISimpleAudioVolume    = {0x87CE5498, 0x68D6, 0x44E5, {0x92,0x15,0x6D,0xA4,0x7E,0xF8,0x83,0xD8}};

typedef HRESULT (WINAPI *ActivateFn)(LPCWSTR, REFIID, PROPVARIANT *,
                                     IActivateAudioInterfaceCompletionHandler *,
                                     IActivateAudioInterfaceAsyncOperation **);

static void fail(const char *what, HRESULT hr) {
  fprintf(stderr, "ERR %s (0x%08lx)\n", what, (unsigned long)hr);
  fflush(stderr);
  ExitProcess(1);
}

// stdout пишут несколько потоков (геймпад, хук мыши) — по одной строке за раз
static CRITICAL_SECTION gOut;
static void outLine(const char *fmt, ...) {
  EnterCriticalSection(&gOut);
  va_list a;
  va_start(a, fmt);
  vfprintf(stdout, fmt, a);
  va_end(a);
  fputc('\n', stdout);
  fflush(stdout);
  LeaveCriticalSection(&gOut);
}

// Координаты в физических пикселях независимо от масштаба Windows
static void dpiAware() {
  typedef BOOL (WINAPI *SetCtx)(HANDLE);
  HMODULE u = GetModuleHandleW(L"user32.dll");
  SetCtx f = u ? (SetCtx)GetProcAddress(u, "SetProcessDpiAwarenessContext") : nullptr;
  if (f) f((HANDLE)-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
}

// Обработчик завершения асинхронной активации. Должен быть agile.
class Handler : public IActivateAudioInterfaceCompletionHandler {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  LONG refs = 1;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
    if (IsEqualIID(riid, kIID_IUnknown) || IsEqualIID(riid, kIID_IAgile) || IsEqualIID(riid, kIID_Handler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs); }
  ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&refs); } // живёт до конца процесса
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *) override {
    SetEvent(done);
    return S_OK;
  }
};

// Если родитель (alloconnect) закрылся — stdin закрывается, выходим.
static DWORD WINAPI StdinWatch(LPVOID) {
  char buf[64];
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  DWORD n;
  while (ReadFile(in, buf, sizeof(buf), &n, nullptr) && n > 0) {}
  ExitProcess(0);
  return 0;
}

// Построчное чтение stdin (для duck и input). false — stdin закрыт.
static bool readLine(std::string &line) {
  static char buf[4096];
  static size_t have = 0;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  for (;;) {
    for (size_t i = 0; i < have; i++) {
      if (buf[i] == '\n') {
        line.assign(buf, i);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        memmove(buf, buf + i + 1, have - i - 1);
        have -= i + 1;
        return true;
      }
    }
    if (have >= sizeof(buf)) have = 0; // мусор без перевода строки — сбрасываем
    DWORD n = 0;
    if (!ReadFile(in, buf + have, (DWORD)(sizeof(buf) - have), &n, nullptr) || n == 0) return false;
    have += n;
  }
}

// Состояние окна: gone | min | normal
static const char *WinState(HWND h) {
  if (!IsWindow(h)) return "gone";
  if (IsIconic(h)) return "min";
  return "normal";
}

// Видимые границы окна (без тени), физические пиксели
static bool WinRect(HWND h, RECT *r) {
  if (SUCCEEDED(DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, sizeof(*r)))) return true;
  return GetWindowRect(h, r) != 0;
}

/* =========================================================
   Дерево процессов alloconnect — их звук не приглушаем
   ========================================================= */
static std::set<DWORD> processTree(DWORD root) {
  std::multimap<DWORD, DWORD> kids;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe = {};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
      do { kids.insert({pe.th32ParentProcessID, pe.th32ProcessID}); } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
  }
  std::set<DWORD> out;
  std::vector<DWORD> stack{root};
  while (!stack.empty()) {
    DWORD p = stack.back();
    stack.pop_back();
    if (!out.insert(p).second) continue;
    auto range = kids.equal_range(p);
    for (auto it = range.first; it != range.second; ++it) if (it->second != p) stack.push_back(it->second);
  }
  return out;
}

/* =========================================================
   duck <pid> — приглушение других программ (как в Discord)
   ========================================================= */
struct Ducked { ISimpleAudioVolume *vol; float orig; bool seen; };
static volatile LONG gDuckTarget = 1000; // ×1000
static volatile LONG gDuckQuit = 0;

static DWORD WINAPI DuckStdin(LPVOID) {
  std::string line;
  while (readLine(line)) {
    if (line.rfind("level ", 0) == 0) {
      double v = atof(line.c_str() + 6);
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      InterlockedExchange(&gDuckTarget, (LONG)(v * 1000));
    }
  }
  InterlockedExchange(&gDuckQuit, 1);
  return 0;
}

static void duckScan(DWORD ourPid, std::map<std::wstring, Ducked> &map, float cur, bool track) {
  IMMDeviceEnumerator *en = nullptr;
  if (FAILED(CoCreateInstance(kCLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, kIID_IMMDeviceEnumerator, (void **)&en))) return;
  std::set<DWORD> ours = processTree(ourPid);
  for (auto &kv : map) kv.second.seen = false;
  IMMDeviceCollection *devs = nullptr;
  if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devs))) {
    UINT n = 0;
    devs->GetCount(&n);
    for (UINT d = 0; d < n; d++) {
      IMMDevice *dev = nullptr;
      if (FAILED(devs->Item(d, &dev))) continue;
      IAudioSessionManager2 *mgr = nullptr;
      if (SUCCEEDED(dev->Activate(kIID_IAudioSessionManager2, CLSCTX_ALL, nullptr, (void **)&mgr))) {
        IAudioSessionEnumerator *se = nullptr;
        if (SUCCEEDED(mgr->GetSessionEnumerator(&se))) {
          int cnt = 0;
          se->GetCount(&cnt);
          for (int i = 0; i < cnt; i++) {
            IAudioSessionControl *ctl = nullptr;
            if (FAILED(se->GetSession(i, &ctl))) continue;
            IAudioSessionControl2 *c2 = nullptr;
            if (SUCCEEDED(ctl->QueryInterface(kIID_IAudioSessionControl2, (void **)&c2))) {
              DWORD pid = 0;
              c2->GetProcessId(&pid);
              bool sys = c2->IsSystemSoundsSession() == S_OK;
              LPWSTR sid = nullptr;
              if (!sys && pid && !ours.count(pid) && SUCCEEDED(c2->GetSessionInstanceIdentifier(&sid)) && sid) {
                std::wstring key(sid);
                CoTaskMemFree(sid);
                auto it = map.find(key);
                if (it != map.end()) {
                  it->second.seen = true;
                } else if (track) {
                  ISimpleAudioVolume *vol = nullptr;
                  if (SUCCEEDED(ctl->QueryInterface(kIID_ISimpleAudioVolume, (void **)&vol)) && vol) {
                    float orig = 1.0f;
                    vol->GetMasterVolume(&orig);
                    map[key] = {vol, orig, true};
                  }
                }
              }
              c2->Release();
            }
            ctl->Release();
          }
          se->Release();
        }
        mgr->Release();
      }
      dev->Release();
    }
    devs->Release();
  }
  en->Release();
  // сессии, которых больше нет
  for (auto it = map.begin(); it != map.end();) {
    if (!it->second.seen) { it->second.vol->Release(); it = map.erase(it); } else ++it;
  }
  (void)cur;
}

static void duckApply(std::map<std::wstring, Ducked> &map, float cur) {
  for (auto &kv : map) kv.second.vol->SetMasterVolume(kv.second.orig * cur, nullptr);
}

static void duckRestore(std::map<std::wstring, Ducked> &map) {
  for (auto &kv : map) { kv.second.vol->SetMasterVolume(kv.second.orig, nullptr); kv.second.vol->Release(); }
  map.clear();
}

static int runDuck(DWORD ourPid) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) fail("CoInitializeEx", hr);
  CreateThread(nullptr, 0, DuckStdin, nullptr, 0, nullptr);
  fprintf(stderr, "OK\n");
  fflush(stderr);
  std::map<std::wstring, Ducked> map;
  float cur = 1.0f;
  DWORD lastScan = 0;
  for (;;) {
    float target = gDuckTarget / 1000.0f;
    if (gDuckQuit) target = 1.0f;
    float prev = cur;
    // быстро приглушаем (~0.15 с), плавно возвращаем (~0.5 с)
    if (cur > target) cur = (cur - 0.2f < target) ? target : cur - 0.2f;
    else if (cur < target) cur = (cur + 0.06f > target) ? target : cur + 0.06f;
    DWORD now = GetTickCount();
    if (cur < 0.999f) {
      if (prev >= 0.999f || now - lastScan > 1500) { duckScan(ourPid, map, cur, true); lastScan = now; }
      if (cur != prev || now - lastScan < 40) duckApply(map, cur);
    } else if (!map.empty()) {
      duckRestore(map);
    }
    if (gDuckQuit && map.empty()) break;
    Sleep(30);
  }
  return 0;
}

/* =========================================================
   input <pid> — удалённое управление
   ========================================================= */
static volatile LONGLONG gLocalUntil = 0;   // пока пользователь сам двигает мышь — управление друга на паузе
static DWORD gLastLocalMsg = 0;

static LRESULT CALLBACK MouseHook(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION) {
    MSLLHOOKSTRUCT *m = (MSLLHOOKSTRUCT *)lp;
    if (!(m->flags & LLMHF_INJECTED)) {
      InterlockedExchange64(&gLocalUntil, (LONGLONG)GetTickCount64() + 700);
      DWORD now = GetTickCount();
      if (now - gLastLocalMsg > 1000) { gLastLocalMsg = now; outLine("local"); }
    }
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}

static DWORD WINAPI HookThread(LPVOID) {
  HHOOK h = SetWindowsHookExW(WH_MOUSE_LL, MouseHook, GetModuleHandleW(nullptr), 0);
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  if (h) UnhookWindowsHookEx(h);
  return 0;
}

static bool processElevated(HANDLE proc, bool *known) {
  HANDLE tok = nullptr;
  *known = false;
  if (!OpenProcessToken(proc, TOKEN_QUERY, &tok)) return false;
  TOKEN_ELEVATION el = {};
  DWORD sz = 0;
  bool r = false;
  if (GetTokenInformation(tok, TokenElevation, &el, sizeof(el), &sz)) { r = el.TokenIsElevated != 0; *known = true; }
  CloseHandle(tok);
  return r;
}

struct InputState {
  int areaMode = 0;      // 0 — весь экран, 1 — прямоугольник, 2 — окно
  RECT area = {};
  HWND areaWin = nullptr;
  bool allowMouse = false, allowKb = false, allowPad = false;
  std::set<int> keys;    // зажатые клавиши: scancode | ext<<8
  int buttons = 0;       // зажатые кнопки мыши
  bool selfElevated = false;
  HWND lastFg = nullptr;
  // геймпад
  PVIGEM_CLIENT vc = nullptr;
  PVIGEM_TARGET pad = nullptr;
  bool padFailed = false;
};
static InputState gIn;

static bool localActive() { return (LONGLONG)GetTickCount64() < gLocalUntil; }

static void checkElevatedTarget() {
  HWND fg = GetForegroundWindow();
  if (!fg || fg == gIn.lastFg) return;
  gIn.lastFg = fg;
  if (gIn.selfElevated) return;
  DWORD pid = 0;
  GetWindowThreadProcessId(fg, &pid);
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return;
  bool known = false;
  bool el = processElevated(p, &known);
  CloseHandle(p);
  if (!known || el) outLine("elev"); // окно от администратора: Windows не пропустит ввод
}

static void sendKey(int sc, bool ext, bool down) {
  INPUT in = {};
  in.type = INPUT_KEYBOARD;
  in.ki.wScan = (WORD)sc;
  in.ki.dwFlags = KEYEVENTF_SCANCODE | (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
  SendInput(1, &in, sizeof(in));
}

static const DWORD kBtnDown[5] = {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XDOWN};
static const DWORD kBtnUp[5] = {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_XUP, MOUSEEVENTF_XUP};

static void sendButton(int b, bool down) {
  if (b < 0 || b > 4) return;
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = down ? kBtnDown[b] : kBtnUp[b];
  if (b == 3) in.mi.mouseData = XBUTTON1;
  if (b == 4) in.mi.mouseData = XBUTTON2;
  SendInput(1, &in, sizeof(in));
}

static void releaseAll() {
  for (int k : gIn.keys) sendKey(k & 0xFF, (k >> 8) & 1, false);
  gIn.keys.clear();
  for (int b = 0; b < 5; b++) if (gIn.buttons & (1 << b)) sendButton(b, false);
  gIn.buttons = 0;
  if (gIn.pad) {
    XUSB_REPORT r = {};
    vigem_target_x360_update(gIn.vc, gIn.pad, r);
  }
}

static bool areaRect(RECT *r) {
  if (gIn.areaMode == 2) {
    if (!IsWindow(gIn.areaWin) || IsIconic(gIn.areaWin)) return false;
    return WinRect(gIn.areaWin, r);
  }
  if (gIn.areaMode == 1) { *r = gIn.area; return true; }
  r->left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  r->top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  r->right = r->left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  r->bottom = r->top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  return true;
}

static void moveAbs(double nx, double ny) {
  RECT a;
  if (!areaRect(&a)) return;
  if (nx < 0) nx = 0;
  if (nx > 1) nx = 1;
  if (ny < 0) ny = 0;
  if (ny > 1) ny = 1;
  double px = a.left + nx * (a.right - a.left - 1);
  double py = a.top + ny * (a.bottom - a.top - 1);
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (vw < 2 || vh < 2) return;
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dx = (LONG)lround((px - vx) * 65535.0 / (vw - 1));
  in.mi.dy = (LONG)lround((py - vy) * 65535.0 / (vh - 1));
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  SendInput(1, &in, sizeof(in));
}

static void CALLBACK OnRumble(PVIGEM_CLIENT, PVIGEM_TARGET, UCHAR large, UCHAR small, UCHAR, LPVOID) {
  outLine("rumble %u %u", (unsigned)large, (unsigned)small);
}

static void padEnsure() {
  if (gIn.pad || gIn.padFailed) return;
  gIn.vc = vigem_alloc();
  if (!gIn.vc) { gIn.padFailed = true; outLine("pad err alloc"); return; }
  VIGEM_ERROR e = vigem_connect(gIn.vc);
  if (!VIGEM_SUCCESS(e)) {
    gIn.padFailed = true;
    vigem_free(gIn.vc);
    gIn.vc = nullptr;
    outLine(e == VIGEM_ERROR_BUS_NOT_FOUND ? "pad err nobus" : "pad err 0x%08x", (unsigned)e);
    return;
  }
  PVIGEM_TARGET t = vigem_target_x360_alloc();
  e = vigem_target_add(gIn.vc, t);
  if (!VIGEM_SUCCESS(e)) {
    gIn.padFailed = true;
    vigem_target_free(t);
    outLine("pad err add 0x%08x", (unsigned)e);
    return;
  }
  gIn.pad = t;
  vigem_target_x360_register_notification(gIn.vc, t, OnRumble, nullptr);
  outLine("pad ok");
}

static void padOff() {
  if (!gIn.pad) return;
  vigem_target_x360_unregister_notification(gIn.pad);
  vigem_target_remove(gIn.vc, gIn.pad);
  vigem_target_free(gIn.pad);
  gIn.pad = nullptr;
}

static bool blockedKey(int sc, bool ext) {
  // клавиша Windows: меню «Пуск», Win+R, Win+L и прочие системные сочетания — не пропускаем
  return ext && (sc == 0x5B || sc == 0x5C);
}

static int runInput() {
  CreateThread(nullptr, 0, HookThread, nullptr, 0, nullptr);
  bool known = false;
  gIn.selfElevated = processElevated(GetCurrentProcess(), &known);
  outLine("OK%s", gIn.selfElevated ? " admin" : "");
  std::string line;
  DWORD lastCmd = GetTickCount();
  while (readLine(line)) {
    const char *s = line.c_str();
    char cmd[16] = {0};
    if (sscanf(s, "%15s", cmd) != 1) continue;
    DWORD now = GetTickCount();
    (void)lastCmd;
    lastCmd = now;
    if (!strcmp(cmd, "perm")) {
      int m = 0, k = 0, p = 0;
      sscanf(s + 4, "%d %d %d", &m, &k, &p);
      gIn.allowMouse = m; gIn.allowKb = k; gIn.allowPad = p;
      if (!p) padOff();
      if (!m || !k) releaseAll();
    } else if (!strcmp(cmd, "area")) {
      long x, y, w, h;
      if (sscanf(s + 4, "%ld %ld %ld %ld", &x, &y, &w, &h) == 4 && w > 0 && h > 0) {
        gIn.areaMode = 1;
        gIn.area = {x, y, x + w, y + h};
      }
    } else if (!strcmp(cmd, "areawin")) {
      unsigned long long hw = _strtoui64(s + 7, nullptr, 10);
      gIn.areaMode = 2;
      gIn.areaWin = (HWND)(uintptr_t)hw;
    } else if (!strcmp(cmd, "m")) {
      double x, y;
      if (gIn.allowMouse && !localActive() && sscanf(s + 1, "%lf %lf", &x, &y) == 2) moveAbs(x, y);
    } else if (!strcmp(cmd, "r")) {
      int dx, dy;
      if (gIn.allowMouse && !localActive() && sscanf(s + 1, "%d %d", &dx, &dy) == 2) {
        if (dx > 2000) dx = 2000;
        if (dx < -2000) dx = -2000;
        if (dy > 2000) dy = 2000;
        if (dy < -2000) dy = -2000;
        INPUT in = {};
        in.type = INPUT_MOUSE;
        in.mi.dx = dx;
        in.mi.dy = dy;
        in.mi.dwFlags = MOUSEEVENTF_MOVE;
        SendInput(1, &in, sizeof(in));
      }
    } else if (!strcmp(cmd, "b")) {
      int b, d;
      if (gIn.allowMouse && sscanf(s + 1, "%d %d", &b, &d) == 2 && b >= 0 && b < 5) {
        if (d && localActive()) continue;
        if (d) checkElevatedTarget();
        if (d && !(gIn.buttons & (1 << b))) { gIn.buttons |= 1 << b; sendButton(b, true); }
        else if (!d && (gIn.buttons & (1 << b))) { gIn.buttons &= ~(1 << b); sendButton(b, false); }
      }
    } else if (!strcmp(cmd, "w")) {
      int dy = 0, dx = 0;
      if (gIn.allowMouse && !localActive() && sscanf(s + 1, "%d %d", &dy, &dx) >= 1) {
        INPUT in = {};
        in.type = INPUT_MOUSE;
        if (dy) { in.mi.dwFlags = MOUSEEVENTF_WHEEL; in.mi.mouseData = (DWORD)dy; SendInput(1, &in, sizeof(in)); }
        if (dx) { in.mi.dwFlags = MOUSEEVENTF_HWHEEL; in.mi.mouseData = (DWORD)dx; SendInput(1, &in, sizeof(in)); }
      }
    } else if (!strcmp(cmd, "k")) {
      int sc, ext, d;
      if (gIn.allowKb && sscanf(s + 1, "%d %d %d", &sc, &ext, &d) == 3 && sc > 0 && sc < 256) {
        if (blockedKey(sc, ext)) continue;
        int key = sc | ((ext ? 1 : 0) << 8);
        if (d) {
          checkElevatedTarget();
          gIn.keys.insert(key);
          sendKey(sc, ext, true); // повтор при удержании приходит от друга тоже
        } else if (gIn.keys.count(key)) {
          gIn.keys.erase(key);
          sendKey(sc, ext, false);
        }
      }
    } else if (!strcmp(cmd, "pad")) {
      unsigned btn; int lt, rt, lx, ly, rx, ry;
      if (gIn.allowPad && sscanf(s + 3, "%u %d %d %d %d %d %d", &btn, &lt, &rt, &lx, &ly, &rx, &ry) == 7) {
        padEnsure();
        if (gIn.pad) {
          XUSB_REPORT r = {};
          r.wButtons = (USHORT)btn;
          r.bLeftTrigger = (BYTE)(lt < 0 ? 0 : lt > 255 ? 255 : lt);
          r.bRightTrigger = (BYTE)(rt < 0 ? 0 : rt > 255 ? 255 : rt);
          auto cl = [](int v) { return (SHORT)(v < -32768 ? -32768 : v > 32767 ? 32767 : v); };
          r.sThumbLX = cl(lx); r.sThumbLY = cl(ly); r.sThumbRX = cl(rx); r.sThumbRY = cl(ry);
          vigem_target_x360_update(gIn.vc, gIn.pad, r);
        }
      }
    } else if (!strcmp(cmd, "padoff")) {
      padOff();
    } else if (!strcmp(cmd, "rel")) {
      releaseAll();
    }
  }
  // alloconnect закрылся или забрал управление — отпускаем всё
  releaseAll();
  padOff();
  if (gIn.vc) { vigem_disconnect(gIn.vc); vigem_free(gIn.vc); }
  return 0;
}

/* =========================================================
   keys <vk,vk,...> — push-to-talk: глобально следим за клавишами/кнопками мыши.
   Печатает "down <vk>" / "up <vk>". Команда из stdin "set <vk,...>" меняет набор.
   VK мыши: 4 — средняя, 5 — боковая «назад», 6 — боковая «вперёд».
   ========================================================= */
static volatile LONG gKeyMask[8] = {0};   // 256 бит: за какими VK следим
static bool gKeyDown[256] = {false};

static void setKeys(const char *list) {
  for (int i = 0; i < 8; i++) InterlockedExchange(&gKeyMask[i], 0);
  const char *p = list;
  while (*p) {
    char *end = nullptr;
    long vk = strtol(p, &end, 10);
    if (end == p) break;
    if (vk > 0 && vk < 256) InterlockedOr(&gKeyMask[vk >> 5], (LONG)(1u << (vk & 31)));
    p = end;
    while (*p == ',' || *p == ' ') p++;
  }
}
static bool watched(int vk) { return vk > 0 && vk < 256 && (gKeyMask[vk >> 5] & (LONG)(1u << (vk & 31))); }

static void keyEvent(int vk, bool down) {
  if (!watched(vk) || gKeyDown[vk] == down) return;
  gKeyDown[vk] = down;
  outLine("%s %d", down ? "down" : "up", vk);
}

static LRESULT CALLBACK PttKeyHook(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION) {
    KBDLLHOOKSTRUCT *k = (KBDLLHOOKSTRUCT *)lp;
    int vk = (int)k->vkCode;
    // левые/правые модификаторы → общий код (Ctrl, Shift, Alt)
    bool down = wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN;
    keyEvent(vk, down);
    if (vk == VK_LCONTROL || vk == VK_RCONTROL) keyEvent(VK_CONTROL, down);
    if (vk == VK_LSHIFT || vk == VK_RSHIFT) keyEvent(VK_SHIFT, down);
    if (vk == VK_LMENU || vk == VK_RMENU) keyEvent(VK_MENU, down);
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}

static LRESULT CALLBACK PttMouseHook(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION) {
    MSLLHOOKSTRUCT *m = (MSLLHOOKSTRUCT *)lp;
    switch (wp) {
      case WM_MBUTTONDOWN: keyEvent(VK_MBUTTON, true); break;
      case WM_MBUTTONUP: keyEvent(VK_MBUTTON, false); break;
      case WM_XBUTTONDOWN: keyEvent(HIWORD(m->mouseData) == XBUTTON1 ? VK_XBUTTON1 : VK_XBUTTON2, true); break;
      case WM_XBUTTONUP: keyEvent(HIWORD(m->mouseData) == XBUTTON1 ? VK_XBUTTON1 : VK_XBUTTON2, false); break;
      default: break;
    }
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}

static DWORD WINAPI KeysStdin(LPVOID) {
  std::string line;
  while (readLine(line)) {
    if (line.rfind("set ", 0) == 0) setKeys(line.c_str() + 4);
  }
  ExitProcess(0);
  return 0;
}

static int runKeys(const char *list) {
  setKeys(list);
  CreateThread(nullptr, 0, KeysStdin, nullptr, 0, nullptr);
  HHOOK hk = SetWindowsHookExW(WH_KEYBOARD_LL, PttKeyHook, GetModuleHandleW(nullptr), 0);
  HHOOK hm = SetWindowsHookExW(WH_MOUSE_LL, PttMouseHook, GetModuleHandleW(nullptr), 0);
  if (!hk) { fprintf(stderr, "ERR hook\n"); fflush(stderr); return 1; }
  outLine("OK");
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  UnhookWindowsHookEx(hk);
  if (hm) UnhookWindowsHookEx(hm);
  return 0;
}

/* =========================================================
   fg — во что играет пользователь: полноэкранное окно на переднем плане.
   Печатает при изменении: "fg 1\t<exe>\t<заголовок>" или "fg 0".
   ========================================================= */
static std::string toUtf8(const wchar_t *w) {
  if (!w || !*w) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  for (char &c : s) if (c == '\t' || c == '\n' || c == '\r') c = ' ';
  return s;
}

static int runFg() {
  CreateThread(nullptr, 0, StdinWatch, nullptr, 0, nullptr);
  std::string last = "-";
  for (;;) {
    std::string cur = "fg 0";
    HWND h = GetForegroundWindow();
    if (h && IsWindowVisible(h) && !IsIconic(h)) {
      wchar_t cls[64] = {0};
      GetClassNameW(h, cls, 64);
      bool shell = !wcscmp(cls, L"WorkerW") || !wcscmp(cls, L"Progman") || !wcscmp(cls, L"Shell_TrayWnd");
      RECT wr;
      MONITORINFO mi = {};
      mi.cbSize = sizeof(mi);
      if (!shell && GetWindowRect(h, &wr) && GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mi)) {
        RECT m = mi.rcMonitor;
        if (wr.left <= m.left && wr.top <= m.top && wr.right >= m.right && wr.bottom >= m.bottom) {
          DWORD pid = 0;
          GetWindowThreadProcessId(h, &pid);
          wchar_t path[MAX_PATH] = {0};
          DWORD sz = MAX_PATH;
          HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
          if (p) { QueryFullProcessImageNameW(p, 0, path, &sz); CloseHandle(p); }
          const wchar_t *exe = wcsrchr(path, L'\\');
          exe = exe ? exe + 1 : path;
          wchar_t title[256] = {0};
          GetWindowTextW(h, title, 256);
          cur = "fg 1\t" + toUtf8(exe) + "\t" + toUtf8(title);
        }
      }
    }
    if (cur != last) { outLine("%s", cur.c_str()); last = cur; }
    Sleep(2000);
  }
}

/* =========================================================
   apply <result> <pid> <exe> <src1> <dst1> [<src2> <dst2> ...] — установка обновления:
   ждём выхода alloconnect, старые файлы → *.old, новые на место, запускаем снова.
   swap <result> <pid> <exe> <file1> [<file2> ...] — откат: меняем местами file и file.old.
   Пути — в Юникоде (папка может быть с русскими буквами).
   ========================================================= */
static void writeResult(const wchar_t *path, const char *text) {
  HANDLE f = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD n = 0;
  WriteFile(f, text, (DWORD)strlen(text), &n, nullptr);
  CloseHandle(f);
}

static void waitPid(DWORD pid) {
  HANDLE p = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (p) { WaitForSingleObject(p, 60000); CloseHandle(p); }
  Sleep(700); // дочерние процессы Electron тоже успевают закрыться
}

// MoveFileEx с повторами: антивирус или закрывающийся процесс может держать файл ещё секунду
static bool moveRetry(const wchar_t *a, const wchar_t *b) {
  for (int i = 0; i < 20; i++) {
    if (MoveFileExW(a, b, MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED)) return true;
    Sleep(250);
  }
  return false;
}
static bool copyRetry(const wchar_t *a, const wchar_t *b) {
  for (int i = 0; i < 20; i++) {
    if (CopyFileW(a, b, FALSE)) return true;
    Sleep(250);
  }
  return false;
}

static void relaunch(const wchar_t *exe) {
  std::wstring cmd = L"\"" + std::wstring(exe) + L"\" --updated";
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {};
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(0);
  if (CreateProcessW(exe, buf.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS, nullptr, nullptr, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

static int runApply(int wargc, wchar_t **wargv, bool swap) {
  // wargv: [0]=exe [1]=apply|swap [2]=result [3]=pid [4]=app exe [5...]=файлы
  if (wargc < 6) return 2;
  const wchar_t *result = wargv[2];
  DWORD pid = (DWORD)wcstoul(wargv[3], nullptr, 10);
  const wchar_t *appExe = wargv[4];
  waitPid(pid);
  std::vector<std::wstring> done; // dst, у которых уже есть .old
  bool ok = true;
  std::string err;
  if (!swap) {
    if ((wargc - 5) % 2 != 0) return 2;
    for (int i = 5; i + 1 < wargc; i += 2) {
      std::wstring src = wargv[i], dst = wargv[i + 1], old = dst + L".old";
      if (GetFileAttributesW(dst.c_str()) != INVALID_FILE_ATTRIBUTES && !moveRetry(dst.c_str(), old.c_str())) { ok = false; err = "backup " + toUtf8(dst.c_str()); break; }
      done.push_back(dst);
      if (!copyRetry(src.c_str(), dst.c_str())) { ok = false; err = "copy " + toUtf8(dst.c_str()); break; }
    }
    if (!ok) { // возвращаем всё как было
      for (auto &dst : done) { std::wstring old = dst + L".old"; DeleteFileW(dst.c_str()); MoveFileExW(old.c_str(), dst.c_str(), MOVEFILE_REPLACE_EXISTING); }
    }
  } else {
    auto swapOne = [](const std::wstring &f) -> bool {
      std::wstring old = f + L".old", tmp = f + L".swap";
      if (GetFileAttributesW(old.c_str()) == INVALID_FILE_ATTRIBUTES) return false;
      if (!moveRetry(f.c_str(), tmp.c_str())) return false;
      if (!moveRetry(old.c_str(), f.c_str())) { MoveFileExW(tmp.c_str(), f.c_str(), MOVEFILE_REPLACE_EXISTING); return false; }
      moveRetry(tmp.c_str(), old.c_str());
      return true;
    };
    for (int i = 5; i < wargc; i++) {
      std::wstring f = wargv[i];
      if (!swapOne(f)) { ok = false; err = "swap " + toUtf8(f.c_str()); break; }
      done.push_back(f);
    }
    if (!ok) for (auto &f : done) swapOne(f); // меняем обратно уже переключённые
  }
  writeResult(result, ok ? "ok" : ("err " + err).c_str());
  relaunch(appExe);
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  InitializeCriticalSection(&gOut);
  dpiAware();
  if (argc < 3) { fprintf(stderr, "ERR usage: alloconnect-helper exclude <pid> | window <hwnd> | watch <hwnd> | restore <hwnd> | duck <pid> | input <pid>\n"); return 2; }

  // watch <hwnd> — печатает состояние окна и его прямоугольник при каждом изменении
  if (strcmp(argv[1], "watch") == 0) {
    HWND h = (HWND)(uintptr_t)_strtoui64(argv[2], nullptr, 10);
    CreateThread(nullptr, 0, StdinWatch, nullptr, 0, nullptr);
    const char *last = "";
    RECT lastR = {0, 0, 0, 0};
    for (;;) {
      const char *st = WinState(h);
      if (strcmp(st, last) != 0) {
        outLine("%s", st);
        last = st;
        if (strcmp(st, "gone") == 0) return 0;
      }
      RECT r;
      if (strcmp(st, "normal") == 0 && WinRect(h, &r) && memcmp(&r, &lastR, sizeof(r)) != 0) {
        lastR = r;
        outLine("rect %ld %ld %ld %ld", r.left, r.top, r.right - r.left, r.bottom - r.top);
      }
      Sleep(200);
    }
  }
  // restore <hwnd> — развернуть свёрнутое окно, не забирая фокус
  if (strcmp(argv[1], "restore") == 0) {
    HWND h = (HWND)(uintptr_t)_strtoui64(argv[2], nullptr, 10);
    if (!IsWindow(h)) { fprintf(stderr, "ERR gone\n"); return 1; }
    if (IsIconic(h)) ShowWindow(h, SW_SHOWNOACTIVATE);
    fprintf(stderr, "OK\n");
    return 0;
  }
  if (strcmp(argv[1], "duck") == 0) return runDuck((DWORD)strtoul(argv[2], nullptr, 10));
  if (strcmp(argv[1], "keys") == 0) return runKeys(argv[2]);
  if (strcmp(argv[1], "fg") == 0) return runFg();
  if (strcmp(argv[1], "apply") == 0 || strcmp(argv[1], "swap") == 0) {
    int wargc = 0;
    wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (!wargv) return 2;
    return runApply(wargc, wargv, strcmp(argv[1], "swap") == 0);
  }
  if (strcmp(argv[1], "input") == 0) return runInput();

  _setmode(_fileno(stdout), _O_BINARY);

  DWORD pid = 0;
  DWORD mode = LOOPBACK_EXCLUDE_TREE;
  if (strcmp(argv[1], "exclude") == 0) {
    pid = (DWORD)strtoul(argv[2], nullptr, 10);
  } else if (strcmp(argv[1], "window") == 0) {
    HWND hwnd = (HWND)(uintptr_t)_strtoui64(argv[2], nullptr, 10);
    GetWindowThreadProcessId(hwnd, &pid);
    mode = LOOPBACK_INCLUDE_TREE;
  }
  if (!pid) fail("bad target", E_INVALIDARG);

  CreateThread(nullptr, 0, StdinWatch, nullptr, 0, nullptr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) fail("CoInitializeEx", hr);

  HMODULE mm = LoadLibraryW(L"Mmdevapi.dll");
  ActivateFn activate = mm ? (ActivateFn)GetProcAddress(mm, "ActivateAudioInterfaceAsync") : nullptr;
  if (!activate) fail("ActivateAudioInterfaceAsync missing", E_NOTIMPL);

  ACTIVATION_PARAMS_ params = {};
  params.ActivationType = ACT_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = (BYTE *)&params;

  Handler *handler = new Handler();
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  hr = activate(PROCESS_LOOPBACK_DEVICE, kIID_AudioClient, &pv, handler, &op);
  if (FAILED(hr)) fail("activate (нужна Windows 10 2004+)", hr);
  if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) fail("activate timeout", E_FAIL);

  HRESULT actHr = E_FAIL;
  IUnknown *unk = nullptr;
  hr = op->GetActivateResult(&actHr, &unk);
  if (FAILED(hr)) fail("GetActivateResult", hr);
  if (FAILED(actHr) || !unk) fail("activation", actHr);

  IAudioClient *client = nullptr;
  hr = unk->QueryInterface(kIID_AudioClient, (void **)&client);
  if (FAILED(hr)) fail("IAudioClient", hr);

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          200000 /* 20 мс */, 0, &fmt, nullptr);
  if (FAILED(hr)) fail("Initialize", hr);

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) fail("SetEventHandle", hr);

  IAudioCaptureClient *cap = nullptr;
  hr = client->GetService(kIID_Capture, (void **)&cap);
  if (FAILED(hr)) fail("GetService", hr);

  hr = client->Start();
  if (FAILED(hr)) fail("Start", hr);

  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
  fprintf(stderr, "OK\n");
  fflush(stderr);

  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  static BYTE zeros[48000 * 4];
  for (;;) {
    WaitForSingleObject(ready, 100);
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) fail("GetBuffer", hr);
      DWORD bytes = frames * fmt.nBlockAlign;
      const BYTE *src = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? zeros : data;
      DWORD written = 0;
      if (bytes > sizeof(zeros) && src == zeros) bytes = sizeof(zeros);
      if (!WriteFile(out, src, bytes, &written, nullptr)) ExitProcess(0); // alloconnect закрыл трубу
      cap->ReleaseBuffer(frames);
    }
  }
}
