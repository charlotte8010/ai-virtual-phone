from pathlib import Path
import re

ROOT = Path('.')

main_path = ROOT / 'android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt'
text = main_path.read_text(encoding='utf-8')
start_marker = '        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {'
end_marker = '\n\n        // 冷启动带深链'
start = text.index(start_marker)
end = text.index(end_marker, start)

replacement = r'''        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Float 页面大量使用 React 本地状态，不一定产生 WebView URL history。
                // 系统返回先交给页面的统一语义分发器：弹层 > 当前二级页 > 应用首页。
                // 页面可用 data-float-back 精确声明返回动作；旧页面则由 aria/title/左箭头语义兼容。
                val script = """
                    (function () {
                      try {
                        if (typeof window.__floatShellHandleBack === 'function') {
                          try {
                            var customHandled = window.__floatShellHandleBack();
                            if (customHandled === true) return true;
                          } catch (_) {}
                        }

                        try {
                          var backEvent = new CustomEvent('float-shell-back', { cancelable: true });
                          window.dispatchEvent(backEvent);
                          if (backEvent.defaultPrevented) return true;
                        } catch (_) {}

                        function visible(el) {
                          if (!el || !(el instanceof Element)) return false;
                          var style = window.getComputedStyle(el);
                          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
                          var rect = el.getBoundingClientRect();
                          if (rect.width <= 0 || rect.height <= 0) return false;
                          if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
                          var node = el;
                          while (node && node !== document.documentElement) {
                            if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
                            node = node.parentElement;
                          }
                          return true;
                        }

                        function maxZ(el) {
                          var z = 0;
                          var node = el;
                          while (node && node instanceof Element) {
                            var value = parseInt(window.getComputedStyle(node).zIndex, 10);
                            if (!isNaN(value)) z = Math.max(z, value);
                            node = node.parentElement;
                          }
                          return z;
                        }

                        function domIndex(el) {
                          var all = document.getElementsByTagName('*');
                          for (var i = all.length - 1; i >= 0; i--) if (all[i] === el) return i;
                          return 0;
                        }

                        function semanticRank(el, inModal) {
                          if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return 0;
                          if (el.hasAttribute('data-float-back')) return 100;

                          var aria = String(el.getAttribute('aria-label') || '').trim();
                          var title = String(el.getAttribute('title') || '').trim();
                          var text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                          var label = aria || title || text;

                          if (/^返回(?:\b|桌面|上一|消息|购物|黑市|线上|档案|模型|音色|$)/i.test(label)) return 92;
                          if (/^back(?:\b|\s+to\b)/i.test(label)) return 92;

                          var cls = String(el.className || '');
                          if (/\b(page-back-btn|calendar-back-btn|reading-shelf-back|cp-float-back|rb-back|vns-back|vnc-btn)\b/.test(cls)) return 88;

                          if (inModal) {
                            if (/^(关闭|取消|完成|我知道了|close|cancel)$/i.test(label)) return 84;
                            if (/\b(modal-header-btn-muted|nw-detail-close-btn|wb-float-close)\b/.test(cls)) return 82;
                          }

                          var icon = el.querySelector && el.querySelector(
                            'svg.lucide-chevron-left, svg.lucide-arrow-left, svg[data-lucide="chevron-left"], svg[data-lucide="arrow-left"]'
                          );
                          if (icon) return 72;
                          return 0;
                        }

                        function chooseAction(root, inModal) {
                          var nodes = Array.prototype.slice.call(root.querySelectorAll('button, a, [role="button"]'));
                          var best = null;
                          var bestScore = -Infinity;
                          for (var i = 0; i < nodes.length; i++) {
                            var el = nodes[i];
                            if (!visible(el)) continue;
                            var rank = semanticRank(el, inModal);
                            if (!rank) continue;
                            var rect = el.getBoundingClientRect();

                            // 仅靠“左箭头图标”识别时必须位于页面左上区域，避免误点右上菜单/轮播箭头。
                            if (rank === 72) {
                              if (rect.left > Math.max(220, window.innerWidth * 0.45)) continue;
                              if (rect.top > Math.max(300, window.innerHeight * 0.42)) continue;
                            }

                            var score = rank * 1e12 + maxZ(el) * 1e8 - rect.top * 1000 - rect.left + domIndex(el) / 1e6;
                            if (score > bestScore) {
                              bestScore = score;
                              best = el;
                            }
                          }
                          return best;
                        }

                        // 1) 先关闭最上层弹窗/抽屉/全屏覆盖层，绝不穿透到后面的页面返回。
                        var layerSelector = [
                          '[role="dialog"][aria-modal="true"]',
                          '[data-ui="modal"]',
                          '.modal-overlay',
                          '.calendar-edit-modal-overlay',
                          '.nw-modal-backdrop',
                          '.qa-sheet-backdrop',
                          '.qa-devnotice-backdrop',
                          '.mix-sheet-mask',
                          '.wb-modal-overlay',
                          '.chat-html-overlay'
                        ].join(',');
                        var layers = Array.prototype.slice.call(document.querySelectorAll(layerSelector)).filter(visible);
                        if (layers.length) {
                          layers.sort(function (a, b) {
                            var za = maxZ(a), zb = maxZ(b);
                            if (za !== zb) return zb - za;
                            return domIndex(b) - domIndex(a);
                          });
                          var layer = layers[0];
                          var layerAction = chooseAction(layer, true);
                          if (layerAction) {
                            layerAction.click();
                            return true;
                          }
                          // 绝大多数 overlay 本身绑定 onClick={onClose}；没有显式按钮时点击遮罩兜底。
                          if (layer.matches('.modal-overlay, .nw-modal-backdrop, .qa-sheet-backdrop, .qa-devnotice-backdrop, .mix-sheet-mask, .wb-modal-overlay, .chat-html-overlay')) {
                            layer.click();
                            return true;
                          }
                        }

                        // 2) 当前可见页面的精确/语义返回。
                        var pageAction = chooseAction(document, false);
                        if (pageAction) {
                          pageAction.click();
                          return true;
                        }
                      } catch (_) {}
                      return false;
                    })();
                """.trimIndent()

                webView.evaluateJavascript(script) { handled ->
                    if (handled == "true") return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
                }
            }
        })'''

text = text[:start] + replacement + text[end:]
main_path.write_text(text, encoding='utf-8')

# Shared PageShell: make React's actual onBack action explicit to the Android shell.
page_shell = ROOT / 'components/ui/page-shell.tsx'
s = page_shell.read_text(encoding='utf-8')
s = s.replace(
    '<button className="page-back-btn" type="button" onClick={onBack} aria-label="返回">',
    '<button data-float-back="true" className="page-back-btn" type="button" onClick={onBack} aria-label="返回">',
)
s = s.replace(
    '<button className="page-back-btn pointer-events-auto" type="button" onClick={onBack} aria-label="返回">',
    '<button data-float-back="true" className="page-back-btn pointer-events-auto" type="button" onClick={onBack} aria-label="返回">',
)
page_shell.write_text(s, encoding='utf-8')

# Calendar has custom headers outside PageShell, so mark every real calendar back action.
calendar_month = ROOT / 'components/calendar/month-page.tsx'
s = calendar_month.read_text(encoding='utf-8')
s = s.replace(
    '<button type="button" className="calendar-pill-btn calendar-back-btn" onClick={onClose} aria-label="返回桌面">',
    '<button data-float-back="true" type="button" className="calendar-pill-btn calendar-back-btn" onClick={onClose} aria-label="返回桌面">',
)
calendar_month.write_text(s, encoding='utf-8')

calendar_detail = ROOT / 'components/calendar/detail-page.tsx'
s = calendar_detail.read_text(encoding='utf-8')
s = s.replace(
    '<button type="button" className="calendar-pill-btn calendar-back-btn" onClick={onBack}>',
    '<button data-float-back="true" type="button" className="calendar-pill-btn calendar-back-btn" onClick={onBack}>',
)
calendar_detail.write_text(s, encoding='utf-8')

calendar_modal = ROOT / 'components/calendar/event-edit-modal.tsx'
s = calendar_modal.read_text(encoding='utf-8')
s = s.replace(
    '<button onClick={onClose} className="modal-header-btn modal-header-btn-muted" aria-label="返回">',
    '<button data-float-back="true" onClick={onClose} className="modal-header-btn modal-header-btn-muted" aria-label="返回">',
)
calendar_modal.write_text(s, encoding='utf-8')

calendar_app = ROOT / 'components/calendar-app.tsx'
s = calendar_app.read_text(encoding='utf-8')
s = s.replace(
    '<button onClick={() => setShowMenstrualSettings(false)} className="modal-header-btn modal-header-btn-muted" aria-label="返回">',
    '<button data-float-back="true" onClick={() => setShowMenstrualSettings(false)} className="modal-header-btn modal-header-btn-muted" aria-label="返回">',
)
calendar_app.write_text(s, encoding='utf-8')

# Interview/PRESENCE uses several custom screens; all onBack buttons are genuine one-level returns.
interview = ROOT / 'components/interview/interview-magazine-app.tsx'
s = interview.read_text(encoding='utf-8')
s = s.replace(
    '<button className="interview-icon-btn" onClick={onClose} aria-label="返回桌面">',
    '<button data-float-back="true" className="interview-icon-btn" onClick={onClose} aria-label="返回桌面">',
)
s = re.sub(
    r'<button(?![^>]*data-float-back)([^>]*?)\s+onClick=\{onBack\}([^>]*)>',
    r'<button data-float-back="true"\1 onClick={onBack}\2>',
    s,
)
interview.write_text(s, encoding='utf-8')

print('patched global Android back handling')
