import { useEffect, useRef, useState } from "react";
import jarvisThinkingAnimation from "../../assets/jarvis-thinking.lottie.json";

interface LottieInstance {
  destroy: () => void;
  goToAndStop: (value: number, isFrame?: boolean) => void;
}

export function JarvisThinkingLottie() {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let animation: LottieInstance | null = null;
    const container = containerRef.current;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    void import("lottie-web/build/player/lottie_svg")
      .then(({ default: lottie }) => {
        if (cancelled) return;
        try {
          animation = lottie.loadAnimation({
            container,
            renderer: "svg",
            loop: !reduceMotion,
            autoplay: !reduceMotion,
            animationData: cloneAnimationData(jarvisThinkingAnimation),
            rendererSettings: {
              preserveAspectRatio: "xMidYMid meet",
              progressiveLoad: false,
            },
          });

          if (reduceMotion) {
            animation.goToAndStop(0, true);
          }
        } catch (err) {
          console.warn("Jarvis thinking animation failed to load", err);
          if (!cancelled) setFailed(true);
        }
      })
      .catch((err) => {
        console.warn("Jarvis thinking animation failed to import", err);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      animation?.destroy();
    };
  }, []);

  return (
    <span
      className={`jarvis-thinking-lottie${failed ? " jarvis-thinking-lottie-fallback" : ""}`}
      ref={containerRef}
      aria-hidden="true"
    >
      {failed ? "J" : null}
    </span>
  );
}

function cloneAnimationData<T>(data: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data)) as T;
}
