# Сборка AlloConnect для Android

Сборка использует подписанный ARM64 APK 0.16.17 из новой линейки как основу. Скрипт проверяет SHA-256, заменяет веб-файлы из `www/`, обновляет версию и проверяет, что сертификат APK и ключ проверки обновлений совпадают с опубликованной сборкой. Нативный код и библиотеки берутся из базового APK. Для изменений Java и нативных модулей нужен полный Android-проект, исходники которого утеряны.

Новая линейка использует пакет `com.alloconnect.alo` и канал `android-updates-next`. Установить её можно рядом с 0.16.16. Данные хранятся раздельно.

## Выпуск

Нужны Node.js 24, Java 21 и Android SDK Build Tools 36.0.0. Скачай [базовый APK 0.16.17](https://raw.githubusercontent.com/kepilis/alloconnect/f8c2a5f6c4c2704e24b3abc116aeac10a8f0dc90/alloconnect_android-0.16.17-arm64-v8a.apk).

```powershell
& .\android\build-apk.ps1 -BaseApk "$baseApk" -OutputDirectory "$output" `
  -Node "$nodeExe" -JavaDirectory "$javaBin" -BuildTools "$buildTools" `
  -SigningDirectory "$signingDirectory" -Version 0.16.21 -VersionCode 58 `
  -Notes 'Описание изменений'
```

При следующем выпуске увеличь оба номера версии. Используй существующий каталог подписи с ключом APK, паролем хранилища и ключом Ed25519 для описания обновлений. Храни резервную копию отдельно от ПК и GitHub.

Опубликуй APK и `update-android.json` в одном коммите ветки `android-updates-next`. Подпись APK и его выравнивание проверяет скрипт, а версия и имя пакета читаются из итогового манифеста.
