import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface LoadingProps {
  label?: string;
  description?: ReactNode;
  className?: string;
  size?: "sm" | "md";
  overlay?: boolean;
  overlayTone?: "dark" | "light";
  progress?: number;
  contentVisible?: boolean;
  backgroundClassName?: string;
}

interface LoadingTextProps {
  label: string;
  className?: string;
}

interface ThinkingOrbProps {
  state?: "connecting";
  size?: number;
  speed?: number;
  ink?: "dark" | "light";
}

type Dot = {
  x: number;
  y: number;
  z: number;
  radius: number;
  opacity: number;
  shade: number;
};

type Line = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  opacity: number;
  shade: number;
};

type Point3D = [number, number, number];

const CONNECTING_PRESET_SPEED = 3.315;
const DOT_SIZE_MULTIPLIER = 1.8;

function fraction(value: number) {
  return value - Math.floor(value);
}

function seededRandom(first: number, second: number) {
  const value = Math.sin(first * 12.9898 + second * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function smoothNoise(first: number, second: number) {
  const firstFloor = Math.floor(first);
  const secondFloor = Math.floor(second);
  let firstFraction = first - firstFloor;
  let secondFraction = second - secondFloor;
  firstFraction *= firstFraction * (3 - 2 * firstFraction);
  secondFraction *= secondFraction * (3 - 2 * secondFraction);

  const topLeft = seededRandom(firstFloor, secondFloor);
  const topRight = seededRandom(firstFloor + 1, secondFloor);
  const bottomLeft = seededRandom(firstFloor, secondFloor + 1);
  const bottomRight = seededRandom(firstFloor + 1, secondFloor + 1);

  return (
    topLeft +
    (topRight - topLeft) * firstFraction +
    (bottomLeft - topLeft) * secondFraction +
    (topLeft - topRight - bottomLeft + bottomRight) *
    firstFraction *
    secondFraction
  );
}

function fibonacciPoint(index: number, count: number): Point3D {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (index + 0.5)) / count;
  const horizontalRadius = Math.sqrt(1 - y * y);
  const angle = index * goldenAngle;
  return [
    horizontalRadius * Math.cos(angle),
    y,
    horizontalRadius * Math.sin(angle),
  ];
}

function normalizePoint([x, y, z]: Point3D): Point3D {
  const length = Math.max(0.000001, Math.sqrt(x * x + y * y + z * z));
  return [x / length, y / length, z / length];
}

function makeProjection(
  yaw: number,
  pitch: number,
  center: number,
  scale: number,
) {
  const yawSin = Math.sin(yaw);
  const yawCos = Math.cos(yaw);
  const pitchSin = Math.sin(pitch);
  const pitchCos = Math.cos(pitch);

  return ([x, y, z]: Point3D) => {
    const horizontal = x * yawCos + z * yawSin;
    const depth = -x * yawSin + z * yawCos;
    const vertical = y * pitchCos - depth * pitchSin;
    return {
      x: center + horizontal * scale,
      y: center - vertical * scale,
      z: y * pitchSin + depth * pitchCos,
    };
  };
}

function ThinkingOrb({
  state = "connecting",
  size = 64,
  speed = 1.4,
  ink = "dark",
}: ThinkingOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationSeedRef = useRef(Math.random() * 10_000);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * pixelRatio);
    canvas.height = Math.round(size * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const animationSeed = animationSeedRef.current;
    const nodeMotion = Array.from({ length: 41 }, (_, index) => ({
      speed: 0.68 + seededRandom(animationSeed, index + 11) * 0.74,
      driftRate: 0.16 + seededRandom(animationSeed, index + 37) * 0.22,
      driftAmount: 0.18 + seededRandom(animationSeed, index + 71) * 0.2,
      phase: seededRandom(animationSeed, index + 103) * Math.PI * 2,
    }));
    const signalMotion = Array.from({ length: 7 }, (_, index) => ({
      speed: 0.62 + seededRandom(animationSeed, index + 149) * 0.9,
      phase: seededRandom(animationSeed, index + 181) * 11,
    }));

    const draw = (time: number) => {
      context.clearRect(0, 0, size, size);
      const center = size / 2;
      const sphereRadius = size * 0.4;
      const radiusScale = (size / 300) ** 0.6;
      const nodeCount = 41;
      const signalCount = 7;
      const connectionThreshold = 0.72;
      const nodeRadius = 1.33;
      const nodeRadiusDepth = 1.71;
      const project = makeProjection(time * 0.12, 0.32, center, sphereRadius);

      const nodes = Array.from({ length: nodeCount }, (_, index) => {
        const base = fibonacciPoint(index, nodeCount);
        const motion = nodeMotion[index];
        const localTime =
          time * motion.speed +
          Math.sin(time * motion.driftRate + motion.phase) * motion.driftAmount;
        return normalizePoint([
          base[0] +
          0.6 * (smoothNoise(index * 0.31 + 9, localTime * 0.24) - 0.5),
          base[1] +
          0.6 * (smoothNoise(index * 0.53 + 27, localTime * 0.21) - 0.5),
          base[2] +
          0.6 * (smoothNoise(index * 0.77 + 55, localTime * 0.27) - 0.5),
        ]);
      });
      const projectedNodes = nodes.map(project);
      const lines: Line[] = [];
      const dots: Dot[] = [];

      for (let first = 0;first < nodeCount;first += 1) {
        for (let second = first + 1;second < nodeCount;second += 1) {
          const distance = Math.hypot(
            nodes[first][0] - nodes[second][0],
            nodes[first][1] - nodes[second][1],
            nodes[first][2] - nodes[second][2],
          );
          if (distance >= connectionThreshold) continue;

          const firstPoint = projectedNodes[first];
          const secondPoint = projectedNodes[second];
          const depthFactor = ((firstPoint.z + secondPoint.z) / 2 + 1) / 2;
          lines.push({
            x1: firstPoint.x,
            y1: firstPoint.y,
            x2: secondPoint.x,
            y2: secondPoint.y,
            width: Math.max(0.6, 0.8 * radiusScale),
            opacity:
              (1 - distance / connectionThreshold) *
              (0.3 + 0.55 * depthFactor),
            shade: 0.42,
          });
        }
      }

      projectedNodes.forEach((point, index) => {
        const depthFactor = (point.z + 1) / 2;
        const pulse = 1 + 0.25 * Math.sin(time * 1.4 + index * 2.7);
        dots.push({
          x: point.x,
          y: point.y,
          z: point.z,
          radius:
            (nodeRadius + nodeRadiusDepth * depthFactor) *
            pulse *
            radiusScale *
            DOT_SIZE_MULTIPLIER,
          opacity: 1,
          shade: 0.55 - 0.45 * depthFactor,
        });
      });

      for (let index = 0;index < signalCount;index += 1) {
        const signalTime =
          time * 0.55 * signalMotion[index].speed +
          index * 7.31 +
          signalMotion[index].phase;
        const step = Math.floor(signalTime);
        const sourceIndex = Math.floor(
          seededRandom(step, index * 3.1 + 1.7) * nodeCount,
        );
        const targetIndex = Math.floor(
          seededRandom(step, index * 5.7 + 4.2) * nodeCount,
        );
        if (sourceIndex === targetIndex) continue;

        const progress = fraction(signalTime);
        const signalPoint = normalizePoint([
          nodes[sourceIndex][0] +
          (nodes[targetIndex][0] - nodes[sourceIndex][0]) * progress,
          nodes[sourceIndex][1] +
          (nodes[targetIndex][1] - nodes[sourceIndex][1]) * progress,
          nodes[sourceIndex][2] +
          (nodes[targetIndex][2] - nodes[sourceIndex][2]) * progress,
        ]);
        const projectedSignal = project(signalPoint);
        const depthFactor = (projectedSignal.z + 1) / 2;
        dots.push({
          x: projectedSignal.x,
          y: projectedSignal.y,
          z: projectedSignal.z,
          radius:
            (nodeRadius * 1.5 + nodeRadiusDepth * depthFactor) *
            radiusScale *
            DOT_SIZE_MULTIPLIER,
          opacity: 0.5 + 0.5 * depthFactor,
          shade: 0.05,
        });
      }

      const shadeValue = (shade: number) =>
        Math.round((ink === "light" ? 1 - shade : shade) * 255);

      lines.forEach((line) => {
        if (line.opacity < 0.02) return;
        const value = shadeValue(line.shade);
        context.strokeStyle = `rgba(${value},${value},${value},${line.opacity})`;
        context.lineWidth = line.width;
        context.beginPath();
        context.moveTo(line.x1, line.y1);
        context.lineTo(line.x2, line.y2);
        context.stroke();
      });

      dots.sort((first, second) => first.z - second.z);
      dots.forEach((dot) => {
        const value = shadeValue(dot.shade);
        context.fillStyle = `rgba(${value},${value},${value},${dot.opacity})`;
        context.beginPath();
        context.arc(dot.x, dot.y, Math.max(0.3, dot.radius), 0, Math.PI * 2);
        context.fill();
      });
    };

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let frame = 0;
    let running = true;
    draw(0.6);

    const animate = (timestamp: number) => {
      if (!running) return;
      draw((timestamp / 1000) * CONNECTING_PRESET_SPEED * speed);
      frame = window.requestAnimationFrame(animate);
    };

    if (!reducedMotion) frame = window.requestAnimationFrame(animate);
    return () => {
      running = false;
      window.cancelAnimationFrame(frame);
    };
  }, [ink, size, speed, state]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ width: size, height: size, display: "block" }}
    />
  );
}

function Loading({
  label = "正在加载",
  description,
  className,
  size = "md",
  overlay = false,
  overlayTone = "dark",
  progress,
  contentVisible = true,
  backgroundClassName,
}: LoadingProps) {
  const compact = size === "sm";
  const lightOverlay = overlay && overlayTone === "light";
  const normalizedLabel = normalizeLoadingLabel(label);
  const normalizedProgress =
    progress === undefined ? null : Math.min(1, Math.max(0, progress));
  const remainingProgress = 1 - (normalizedProgress ?? 0);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={normalizedLabel}
      className={cn(
        "relative isolate flex min-h-80 w-full flex-1 flex-col items-center justify-center overflow-hidden px-6 py-10 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-0 z-0",
          overlay
            ? lightOverlay
              ? "bg-card/50 backdrop-blur-[0.35rem]"
              : "bg-overlay/65 backdrop-blur-[0.35rem]"
            : (backgroundClassName ?? "bg-card"),
          normalizedProgress === null
            ? null
            : "transition-[background-color,backdrop-filter] duration-200",
        )}
        style={
          overlay && normalizedProgress !== null
            ? {
              backgroundColor: lightOverlay
                ? `color-mix(in srgb, var(--color-card) ${50 * remainingProgress}%, transparent)`
                : `color-mix(in srgb, var(--color-overlay) ${65 * remainingProgress}%, transparent)`,
              backdropFilter: `blur(${0.35 * remainingProgress}rem)`,
              WebkitBackdropFilter: `blur(${0.35 * remainingProgress}rem)`,
            }
            : undefined
        }
        aria-hidden="true"
      />
      <div
        className={cn(
          "relative z-[1] grid shrink-0 place-items-center transition-opacity duration-300",
          contentVisible ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      >
        <ThinkingOrb
          state="connecting"
          size={compact ? 56 : 64}
          speed={1.4}
          ink={overlay && !lightOverlay ? "light" : "dark"}
        />
      </div>
      <span
        className={cn(
          "relative z-[1] transition-opacity duration-300",
          compact
            ? "mt-3.5 text-ui leading-5"
            : "mt-4 text-loading leading-5.5",
          overlay && !lightOverlay ? "text-white" : "text-foreground",
          contentVisible ? "opacity-100" : "opacity-0",
        )}
      >
        <LoadingText label={normalizedLabel} />
      </span>
      {description ? (
        <span
          className={cn(
            "relative z-[1] mt-1 max-w-96 text-caption leading-5 transition-opacity duration-300",
            overlay && !lightOverlay ? "text-white/75" : "text-muted-foreground",
            contentVisible ? "opacity-100" : "opacity-0",
          )}
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}

function LoadingText({ label, className }: LoadingTextProps) {
  const normalizedLabel = normalizeLoadingLabel(label);

  return (
    <span className={cn("inline-flex items-baseline", className)}>
      <span>{normalizedLabel}</span>
      <span className="ui-loading-dots" aria-hidden="true">
        <span className="ui-loading-dot">.</span>
        <span className="ui-loading-dot">.</span>
        <span className="ui-loading-dot">.</span>
      </span>
    </span>
  );
}

function normalizeLoadingLabel(label: string) {
  return label.replace(/(?:\.{3}|…)+$/u, "").trimEnd();
}

export { Loading, LoadingText };
