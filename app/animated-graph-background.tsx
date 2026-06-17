"use client";

import { useEffect, useRef } from "react";

type GraphNode = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  follow: boolean;
  mover: boolean;
  alpha: number;
  dying: boolean;
  connSince: number;
};

type Edge = { a: number; b: number; alpha: number; dying: boolean };

const CONNECT = 150;
const BREAK = 210;
const MAX_EDGES = 70;
const SAFE_DIST = 26;
const MAX_CONN_MS = 30000;

export function AnimatedGraphBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rgbRef = useRef("113,113,122");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateColor = () => {
      rgbRef.current = media.matches ? "161,161,170" : "113,113,122";
    };

    updateColor();
    media.addEventListener("change", updateColor);
    return () => media.removeEventListener("change", updateColor);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let nodes: GraphNode[] = [];
    const edges = new Map<string, Edge>();
    const mouse = { x: 0, y: 0, t: -Infinity };

    const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const dist2 = (a: GraphNode, b: GraphNode) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.max(18, Math.min(60, Math.round((w * h) / 22000)));
      nodes = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        r: 1.4 + Math.random() * 1.8,
        follow: i === 0,
        mover: i < 3,
        alpha: 1,
        dying: false,
        connSince: -1,
      }));
      edges.clear();
    };

    const respawn = (i: number) => {
      const n = nodes[i];
      n.x = Math.random() * w;
      n.y = Math.random() * h;
      n.vx = (Math.random() - 0.5) * 0.5;
      n.vy = (Math.random() - 0.5) * 0.5;
      n.alpha = 0;
      n.dying = false;
      n.connSince = -1;
      for (const [k, e] of edges) {
        if (e.a === i || e.b === i) edges.delete(k);
      }
    };

    const seedStatic = () => {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length && edges.size < MAX_EDGES; j++) {
          if (dist2(nodes[i], nodes[j]) < CONNECT * CONNECT) {
            edges.set(key(i, j), { a: i, b: j, alpha: 1, dying: false });
          }
        }
      }
    };

    const clampSpeed = (n: GraphNode, max: number) => {
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > max) {
        n.vx = (n.vx / sp) * max;
        n.vy = (n.vy / sp) * max;
      }
    };

    const update = () => {
      const now = performance.now();
      const active = now - mouse.t < 2000;
      const n0 = nodes.length;

      for (let i = 0; i < n0; i++) {
        for (let j = i + 1; j < n0; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 0.01 && d2 < SAFE_DIST * SAFE_DIST) {
            const d = Math.sqrt(d2);
            const push = ((SAFE_DIST - d) / d) * 0.06;
            a.vx -= dx * push;
            a.vy -= dy * push;
            b.vx += dx * push;
            b.vy += dy * push;
          }
        }
      }

      const towed = new Array<boolean>(n0).fill(false);
      const connected = new Array<boolean>(n0).fill(false);
      for (const e of edges.values()) {
        if (e.dying) continue;
        connected[e.a] = true;
        connected[e.b] = true;
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (a.mover === b.mover) continue;
        const driver = a.mover ? a : b;
        const rider = a.mover ? b : a;
        const dx = driver.x - rider.x;
        const dy = driver.y - rider.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - 90) * 0.01;
        rider.vx += (dx / d) * f;
        rider.vy += (dy / d) * f;
        towed[a.mover ? e.b : e.a] = true;
      }

      for (let i = 0; i < n0; i++) {
        const n = nodes[i];
        if (n.mover || n.dying) continue;
        if (connected[i]) {
          if (n.connSince < 0) n.connSince = now;
          else if (now - n.connSince > MAX_CONN_MS) {
            n.dying = true;
            for (const e of edges.values()) {
              if (e.a === i || e.b === i) e.dying = true;
            }
          }
        } else {
          n.connSince = -1;
        }
      }

      for (let i = 0; i < n0; i++) {
        const n = nodes[i];
        if (n.follow) {
          if (active) {
            n.vx += (mouse.x - n.x) * 0.0008;
            n.vy += (mouse.y - n.y) * 0.0008;
          }
          n.vx += (Math.random() - 0.5) * 0.02;
          n.vy += (Math.random() - 0.5) * 0.02;
          n.vx *= 0.97;
          n.vy *= 0.97;
          clampSpeed(n, 2.2);
        } else if (n.mover) {
          n.vx += (Math.random() - 0.5) * 0.1;
          n.vy += (Math.random() - 0.5) * 0.1;
          const sp = Math.hypot(n.vx, n.vy) || 1;
          const ns = sp + (0.8 - sp) * 0.05;
          n.vx = (n.vx / sp) * ns;
          n.vy = (n.vy / sp) * ns;
        } else {
          n.vx += (Math.random() - 0.5) * 0.02;
          n.vy += (Math.random() - 0.5) * 0.02;
          n.vx *= 0.97;
          n.vy *= 0.97;
          clampSpeed(n, towed[i] ? 2 : 0.3);
        }

        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0) {
          n.x = 0;
          n.vx = -n.vx;
        } else if (n.x > w) {
          n.x = w;
          n.vx = -n.vx;
        }
        if (n.y < 0) {
          n.y = 0;
          n.vy = -n.vy;
        } else if (n.y > h) {
          n.y = h;
          n.vy = -n.vy;
        }

        if (n.dying) {
          n.alpha -= 0.04;
          if (n.alpha <= 0) respawn(i);
        } else if (n.alpha < 1) {
          n.alpha = Math.min(1, n.alpha + 0.04);
        }
      }

      if (edges.size < MAX_EDGES && Math.random() < 0.25) {
        const i = (Math.random() * n0) | 0;
        if (!nodes[i].dying) {
          let best = -1;
          let bestD = CONNECT * CONNECT;
          for (let j = 0; j < n0; j++) {
            if (j === i || nodes[j].dying || edges.has(key(i, j))) continue;
            const d = dist2(nodes[i], nodes[j]);
            if (d < bestD) {
              bestD = d;
              best = j;
            }
          }
          if (best >= 0) {
            edges.set(key(i, best), { a: i, b: best, alpha: 0, dying: false });
          }
        }
      }

      for (const [k, e] of edges) {
        if (
          dist2(nodes[e.a], nodes[e.b]) > BREAK * BREAK ||
          Math.random() < 0.002
        ) {
          e.dying = true;
        }
        e.alpha += e.dying ? -0.03 : 0.03;
        if (e.alpha <= 0) edges.delete(k);
        else if (e.alpha > 1) e.alpha = 1;
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const rgb = rgbRef.current;

      for (const e of edges.values()) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        const d = Math.sqrt(dist2(a, b));
        const alpha =
          e.alpha * Math.min(a.alpha, b.alpha) * Math.max(0, 1 - d / BREAK) * 0.5;
        if (alpha <= 0) continue;
        ctx.strokeStyle = `rgba(${rgb},${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        ctx.fillStyle = `rgba(${rgb},${(n.follow ? 0.9 : 0.55) * n.alpha})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    let raf = 0;
    const loop = () => {
      update();
      draw();
      raf = requestAnimationFrame(loop);
    };

    const onPointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.t = performance.now();
    };

    const onResize = () => {
      cancelAnimationFrame(raf);
      build();
      if (reduced) {
        seedStatic();
        draw();
      } else {
        loop();
      }
    };

    build();
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("resize", onResize);

    if (reduced) {
      seedStatic();
      draw();
    } else {
      loop();
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="login-graph-bg"
    />
  );
}
