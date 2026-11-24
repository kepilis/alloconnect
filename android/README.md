# Сборка AlloConnect для Android

Сборка использует подписанный ARM64 APK 0.16.16 как основу. Скрипт проверяет его SHA-256 и подпись, заменяет веб-модули из `www/`, обновляет версию и подписывает новый APK. Нативный код и библиотеки берутся из базового APK. Для изменений Java и нативных модулей нужен полный Android-проект.

Новая линейка использует пакет `com.alloconnect.alo` и канал `android-updates-next`. Установить её можно рядом с 0.16.16. Данные хранятся раздельно.

## Выпуск

Нужны Node.js 24, Java 21 и Android SDK Build Tools 36.0.0. Скачай [базовый APK](https://raw.githubusercontent.com/kepilis/alloconnect/android-updates/alloconnect_android-0.16.16-arm64-v8a.apk).

```powershell
& .\android\build-apk.ps1 -BaseApk "$baseApk" -OutputDirectory "$output" `
  -Node "$nodeExe" -JavaDirectory "$javaBin" -BuildTools "$buildTools" `
  -SigningDirectory "$signingDirectory" -Version 0.16.17 -VersionCode 54
```

При следующем выпуске увеличь оба номера версии. Используй существующий каталог подписи с ключом APK, паролем хранилища и ключом Ed25519 для описания обновлений. Храни резервную копию отдельно от ПК и GitHub. Параметр `-InitializeSigning` нужен только при создании новой линейки с другим пакетом.

Опубликуй APK и `update-android.json` в одном коммите ветки `android-updates-next`. Подпись APK и его выравнивание проверяет скрипт, а версия и имя пакета читаются из итогового манифеста.
