# 麦浪 studio

[下载最新 Mac 安装包（Apple 芯片）](https://github.com/danjuan/mailang-studio-releases/releases/latest/download/mailang-studio-mac-arm64.dmg) · [所有版本和校验值](https://github.com/danjuan/mailang-studio-releases/releases)

适用于搭载 M 系列芯片的 Mac。下载无需登录 GitHub。

## 安装和升级

1. 退出麦浪 studio，打开下载的 DMG。
2. 将「麦浪 studio」拖入「应用程序」。升级时选择「替换」。如果旧版仍叫 `PI-Desktop.app`，先在「应用程序」中把它重命名为 `麦浪 studio.app`。
3. 从「应用程序」启动。安装包使用临时签名，未经 Apple 公证；macOS 可能拦截首次启动，受管理设备还可能限制安装。参见 [Apple 关于打开下载应用的说明](https://support.apple.com/zh-cn/102445)。

第 2 版用户请手动安装一次第 3 版。从第 3 版起，应用启动后会检查新版本；也可以从菜单或设置中检查。收到提醒后点「下载新版」，再打开下载的 DMG 安装。

每个版本的说明列出 DMG 的 SHA-256 和对应源码的固定链接。可在终端运行 `shasum -a 256 mailang-studio-mac-arm64.dmg` 与该版本公布的值比对。
