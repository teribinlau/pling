// 设置页共用的小组件
import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} disabled={disabled}>
      <i />
    </button>
  );
}

export function Row({ title, hint, children, className = '' }: { title: string; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`set-row ${className}`}>
      <div className="txt">
        <b>{title}</b>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** 一段文字 → 二维码图片（data URL）；用 npm 的 qrcode 包在本机生成，不连外网 */
export function useQrDataUrl(text: string, size = 240): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    if (!text) {
      setUrl('');
      return;
    }
    QRCode.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(''));
    return () => {
      alive = false;
    };
  }, [text, size]);
  return url;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
