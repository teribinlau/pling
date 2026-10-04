---
name: Popcart Design System
source: Claude Design — https://claude.ai/design/p/d185f99f-8a88-4c03-af82-5cb479751ddd
note: |
  这是用户自己在 Claude Design 里做的设计系统，下面只摘了应用皮肤要用的 token
  （tokens/colors.css、tokens/effects.css、readme 的 Visual foundations）。完整的系统（组件、UI kit）在上面的项目里。
colors:
  red-500 (brand-primary / danger): "#E4000F"
  red-600 (hover / text-link): "#C2000D"
  red-700 (active): "#9E000B"
  gray-0 (bg-page / surface-card): "#FFFFFF"
  gray-50 (bg-page-alt): "#F7F8FA"
  gray-100 (surface-sunken): "#EEF0F3"
  gray-200 (border-subtle): "#DFE3E8"
  gray-300 (border-strong): "#C5CBD3"
  gray-400: "#9AA3AE"
  gray-500 (text-muted): "#6E7884"
  gray-600 (text-secondary): "#4F5966"
  gray-900 (text-body): "#15181C"
  green-500 / 700: "#2DBE60 / #1F8F47"
  yellow-100 / 500 / 700: "#FFF3C4 / #FFC400 / #D9A400"
  blue-500 (focus-ring / info): "#1B9BFF"
  pink-500 (highlight): "#FF5C9E"
  overlay: "rgba(21,24,28,.56)"
  glass-fill: "rgba(255,255,255,.72)"
rounded: { xs: 6px, sm: 8px, md: 12px, lg: 20px, xl: 28px, pill: 999px }
shadows:
  sm: "0 1px 2px rgba(21,24,28,.06), 0 1px 1px rgba(21,24,28,.04)"
  md: "0 4px 12px rgba(21,24,28,.08), 0 1px 3px rgba(21,24,28,.05)"
  lg: "0 12px 32px rgba(21,24,28,.12), 0 2px 6px rgba(21,24,28,.06)"
  brand: "0 8px 24px rgba(228,0,15,.28)"
typography:
  display: Fredoka 600（Google Fonts 替代字体，−0.01em）
  body: Figtree 400 / 500 / 700
---

# Popcart → 叮一下（原 DZF 提醒）皮肤的对应关系

- 品牌红 `#E4000F` 负责所有主操作（主按钮、选中的 chip、开关、+ 号）；它同时也是 danger 色，所以「逾期 / 今天」也是这个红。
- 白色是卡片和面板，页面底用 gray-50；冷灰（gray-200 / 300）做所有线条。
- 圆角整体放大到 1.4 倍（卡片 14px → 20px = radius-lg），按钮和 chip 用胶囊形。
- 标题、时间数字用 Fredoka，正文 Figtree；中文回落 Noto Sans SC。
- 阴影用系统的 sm / md / lg 三档。

token 在应用里的写法见 `src/skins.css` 的 `:root[data-skin='popcart']`。
