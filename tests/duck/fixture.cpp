#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <iostream>
#include <string>
int main() {
  CoInitializeEx(nullptr,COINIT_MULTITHREADED);
  IMMDeviceEnumerator* en=nullptr; IMMDevice* dev=nullptr; IAudioClient* client=nullptr;
  ISimpleAudioVolume* vol=nullptr; IAudioRenderClient* render=nullptr; WAVEFORMATEX* fmt=nullptr;
  HRESULT hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),(void**)&en);
  if(SUCCEEDED(hr))hr=en->GetDefaultAudioEndpoint(eRender,eConsole,&dev);
  if(SUCCEEDED(hr))hr=dev->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,(void**)&client);
  if(SUCCEEDED(hr))hr=client->GetMixFormat(&fmt);
  GUID session;CoCreateGuid(&session);
  if(SUCCEEDED(hr))hr=client->Initialize(AUDCLNT_SHAREMODE_SHARED,0,1000000,0,fmt,&session);
  if(SUCCEEDED(hr))hr=client->GetService(__uuidof(ISimpleAudioVolume),(void**)&vol);
  if(SUCCEEDED(hr))hr=client->GetService(__uuidof(IAudioRenderClient),(void**)&render);
  if(FAILED(hr)){std::cerr<<"ERR "<<std::hex<<hr<<std::endl;return 1;}
  UINT32 frames=0;client->GetBufferSize(&frames);BYTE* data=nullptr;
  if(SUCCEEDED(render->GetBuffer(frames,&data)))render->ReleaseBuffer(frames,AUDCLNT_BUFFERFLAGS_SILENT);
  vol->SetMasterVolume(.73f,nullptr);client->Start();
  std::cout<<"READY "<<GetCurrentProcessId()<<std::endl;
  std::string line;while(std::getline(std::cin,line)){
    if(line=="get"){float v=-1;vol->GetMasterVolume(&v);std::cout<<"VOL "<<v<<std::endl;}
    if(line=="quit")break;
  }
  client->Stop();vol->SetMasterVolume(.73f,nullptr);vol->Release();render->Release();client->Release();dev->Release();en->Release();CoTaskMemFree(fmt);CoUninitialize();return 0;
}
