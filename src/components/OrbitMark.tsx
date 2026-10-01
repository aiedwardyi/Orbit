import { useId } from "react";

export function OrbitMark({ size = 76 }: { size?: number }) {
  // Several marks can share a page, so gradient/filter ids must be unique.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const prompt = (
    <>
      <path
        d="M72 86 L122 128 L72 170"
        fill="none"
        stroke="#FF4D9D"
        strokeWidth="28"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="146" y="156" width="52" height="28" rx="14" fill="#FFD447" />
    </>
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role="img"
      aria-label="Wink"
      className="drop-shadow-[0_14px_32px_rgba(0,0,0,0.45)]"
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1F2747" />
          <stop offset="1" stopColor="#0A0E19" />
        </linearGradient>
        <radialGradient id={`${id}-halo`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FF4D9D" stopOpacity="0.22" />
          <stop offset="1" stopColor="#FF4D9D" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
        <clipPath id={`${id}-clip`}>
          <rect x="12" y="12" width="232" height="232" rx="54" />
        </clipPath>
      </defs>
      <rect x="12" y="12" width="232" height="232" rx="54" fill={`url(#${id}-tile)`} />
      <g clipPath={`url(#${id}-clip)`}>
        <circle cx="128" cy="128" r="118" fill={`url(#${id}-halo)`} />
        <g filter={`url(#${id}-glow)`} opacity="0.7">
          {prompt}
        </g>
        {prompt}
      </g>
      <rect
        x="13.5"
        y="13.5"
        width="229"
        height="229"
        rx="52.5"
        fill="none"
        stroke="#323B5C"
        strokeWidth="3"
      />
    </svg>
  );
}
