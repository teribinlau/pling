// 叮一下的标志：摆动的铃铛 + 两道「叮」的声波（和应用图标同一个图形，design/icon/pling.svg）
export function BrandMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="116" fill="var(--brand-bg, #121212)" />
      <g transform="translate(9 60) scale(0.9)">
        <g transform="rotate(14 230 112)" fill="var(--brand-ink, #fff)">
          <circle cx="230" cy="108" r="22" />
          <path d="M230 122c-60 0-96 46-96 104v54c0 28-13 48-35 64h262c-22-16-35-36-35-64v-54c0-58-36-104-96-104z" />
          <path d="M192 364h76a38 38 0 0 1-76 0z" />
        </g>
        <g fill="none" stroke="var(--brand-wave, #FF4B3E)" strokeWidth="32" strokeLinecap="round">
          <path d="M344 118A112 112 0 0 1 424 198" />
          <path d="M360 56A176 176 0 0 1 486 182" />
        </g>
      </g>
    </svg>
  );
}
