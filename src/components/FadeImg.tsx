import { useEffect, useRef, useState } from "react";

/**
 * 带骨架占位与淡入的图片：
 * 加载前显示微光骨架（shimmer），加载完成后淡入并轻微缩放落定。
 * 挂载时检查 img.complete：命中浏览器缓存的图片可能在监听挂上前就
 * 完成（onLoad 不触发），必须直接视为已加载，否则永远停在骨架灰。
 */
export default function FadeImg({
  src,
  className,
  alt = "",
  onClick,
}: {
  src: string;
  className?: string;
  alt?: string;
  onClick?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    const el = imgRef.current;
    if (el?.complete && el.naturalWidth > 0) setLoaded(true);
  }, [src]);

  return (
    <div
      className={`fade-img ${loaded ? "loaded" : ""} ${failed ? "failed" : ""} ${className ?? ""}`}
      onClick={onClick}
    >
      {!loaded && !failed && <div className="shimmer" aria-hidden />}
      {failed && <span className="img-fallback" aria-hidden>🖼</span>}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
