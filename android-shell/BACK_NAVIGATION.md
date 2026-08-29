# Android back navigation

Float 的 Android 壳会把系统返回/侧滑返回先交给网页当前可见层处理，再退到 WebView 历史或把 App 放到后台。

优先级：

1. 当前最上层弹窗、抽屉或覆盖层。
2. 当前二级页面的真实返回动作。
3. WebView 历史。
4. App 后台。

网页可以在真实返回按钮上添加 `data-float-back="true"`，让原生壳精确调用该按钮。共享 `PageShell`、日历和《在场》已经接入；旧页面继续兼容 `aria-label/title` 的“返回 / Back”语义和左上角 ChevronLeft / ArrowLeft 图标。
