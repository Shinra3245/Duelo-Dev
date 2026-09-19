'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

type DuelArenaCanvasProps = {
  className?: string;
};

export function DuelArenaCanvas({ className = '' }: DuelArenaCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const [webglReady, setWebglReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = arenaRef.current;
    if (!canvas || !container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 3.9, 10.2);
    camera.lookAt(0, 1.1, 0);

    const world = new THREE.Group();
    scene.add(world);
    scene.add(new THREE.HemisphereLight(0xb9eaff, 0x09111f, 2.1));

    const keyLight = new THREE.DirectionalLight(0xa8eaff, 3.2);
    keyLight.position.set(-4, 7, 5);
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(0xa855f7, 12, 14, 2);
    rimLight.position.set(4, 2.6, -2);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(15, 20, 0x2b6585, 0x183047);
    grid.position.y = -0.02;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.65;
    });
    world.add(grid);

    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(4.7, 4.7, 0.18, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0a1728,
        metalness: 0.65,
        roughness: 0.32,
      }),
    );
    platform.position.y = 0.02;
    world.add(platform);

    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(4.35, 0.035, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.72 }),
    );
    outerRing.rotation.x = Math.PI / 2;
    outerRing.position.y = 0.16;
    world.add(outerRing);

    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.3, 0.022, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.8 }),
    );
    innerRing.rotation.x = Math.PI / 2;
    innerRing.position.y = 0.17;
    world.add(innerRing);

    const createDuelist = (color: number, accent: number, x: number, direction: number) => {
      const duelist = new THREE.Group();
      duelist.position.set(x, 0.35, 0);
      duelist.rotation.y = direction * 0.16;

      const bodyMaterial = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.18,
        metalness: 0.58,
        roughness: 0.28,
      });
      const accentMaterial = new THREE.MeshStandardMaterial({
        color: accent,
        emissive: accent,
        emissiveIntensity: 1.1,
        metalness: 0.35,
        roughness: 0.2,
      });

      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.68, 1.2, 5, 12), bodyMaterial);
      body.position.y = 1.28;
      duelist.add(body);

      const shoulder = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.09, 8, 32), accentMaterial);
      shoulder.rotation.x = Math.PI / 2;
      shoulder.position.y = 1.44;
      duelist.add(shoulder);

      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), accentMaterial);
      core.position.set(0, 1.28, 0.59);
      duelist.add(core);

      const visor = new THREE.Mesh(
        new THREE.SphereGeometry(0.36, 16, 8),
        new THREE.MeshBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.92 }),
      );
      visor.scale.set(1.4, 0.44, 0.28);
      visor.position.set(0, 1.78, 0.48);
      duelist.add(visor);

      const antenna = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.46, 8),
        accentMaterial,
      );
      antenna.position.set(0, 2.3, 0);
      duelist.add(antenna);

      const signal = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), accentMaterial);
      signal.position.set(0, 2.56, 0);
      duelist.add(signal);

      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.82, 0.7, 0.16, 8),
        new THREE.MeshStandardMaterial({ color: 0x07111f, metalness: 0.75, roughness: 0.24 }),
      );
      foot.position.y = 0.32;
      duelist.add(foot);

      world.add(duelist);
      return { duelist, signal, core };
    };

    const leftDuelist = createDuelist(0x0e7490, 0x67e8f9, -2.1, 1);
    const rightDuelist = createDuelist(0x5b21b6, 0xc084fc, 2.1, -1);

    const particleCount = 72;
    const particlePositions = new Float32Array(particleCount * 3);
    let seed = 17;
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let index = 0; index < particleCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 2.3 + random() * 4.7;
      particlePositions[index * 3] = Math.cos(angle) * radius;
      particlePositions[index * 3 + 1] = 0.5 + random() * 4.2;
      particlePositions[index * 3 + 2] = (random() - 0.5) * 3.3;
    }
    const particlesGeometry = new THREE.BufferGeometry();
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    const particles = new THREE.Points(
      particlesGeometry,
      new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.045, transparent: true, opacity: 0.74 }),
    );
    world.add(particles);

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = reducedMotionQuery.matches;
    let visible = true;
    let animationFrame = 0;
    let targetCameraX = 0;
    let targetCameraY = 3.9;

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      const safeWidth = Math.max(width, 280);
      const safeHeight = Math.max(height, 260);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };

    const renderFrame = () => {
      animationFrame = 0;
      if (!visible) return;
      animationFrame = window.requestAnimationFrame(renderFrame);

      if (!reducedMotion) {
        const elapsed = performance.now() * 0.001;
        world.rotation.y = Math.sin(elapsed * 0.16) * 0.045;
        outerRing.rotation.z += 0.0015;
        innerRing.rotation.z -= 0.0025;
        particles.rotation.y += 0.0007;
        leftDuelist.duelist.position.y = 0.35 + Math.sin(elapsed * 1.6) * 0.045;
        rightDuelist.duelist.position.y = 0.35 + Math.sin(elapsed * 1.6 + Math.PI) * 0.045;
        leftDuelist.signal.scale.setScalar(1 + Math.sin(elapsed * 3.2) * 0.16);
        rightDuelist.signal.scale.setScalar(1 + Math.sin(elapsed * 3.2 + Math.PI) * 0.16);
        leftDuelist.core.rotation.y += 0.018;
        rightDuelist.core.rotation.y -= 0.018;
      }

      camera.position.x += (targetCameraX - camera.position.x) * 0.04;
      camera.position.y += (targetCameraY - camera.position.y) * 0.04;
      camera.lookAt(0, 1.1, 0);
      renderer.render(scene, camera);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion) return;
      const bounds = container.getBoundingClientRect();
      const normalizedX = (event.clientX - bounds.left) / bounds.width - 0.5;
      const normalizedY = (event.clientY - bounds.top) / bounds.height - 0.5;
      targetCameraX = normalizedX * 0.55;
      targetCameraY = 3.9 - normalizedY * 0.32;
    };

    const onPointerLeave = () => {
      targetCameraX = 0;
      targetCameraY = 3.9;
    };

    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) {
        targetCameraX = 0;
        targetCameraY = 3.9;
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        visible = entry.isIntersecting;
        if (visible && animationFrame === 0) renderFrame();
      },
      { threshold: 0.05 },
    );

    resizeObserver.observe(container);
    visibilityObserver.observe(container);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);
    reducedMotionQuery.addEventListener('change', onMotionPreferenceChange);
    setWebglReady(true);
    resize();
    renderFrame();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      reducedMotionQuery.removeEventListener('change', onMotionPreferenceChange);
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.Line ||
          object instanceof THREE.Points
        ) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={arenaRef}
      className={`duel-arena-canvas ${className}`}
      role="img"
      aria-label="Arena tridimensional con dos duelistas de código enfrentados"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {!webglReady && (
        <div className="duel-arena-fallback" aria-hidden="true">
          <div className="duel-arena-fallback-ring duel-arena-fallback-ring-left" />
          <div className="duel-arena-fallback-ring duel-arena-fallback-ring-right" />
          <span className="duel-arena-fallback-core">VS</span>
        </div>
      )}
      <div className="duel-arena-hud" aria-hidden="true">
        <span className="duel-arena-hud-label">ARENA ONLINE</span>
        <span className="duel-arena-hud-status">
          <i /> Python 3
        </span>
      </div>
    </div>
  );
}
