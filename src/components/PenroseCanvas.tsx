import { useEffect, useRef } from 'react';

interface PenroseCanvasProps {
  triangleEdge?: number;
  cubeEdge?: number;
  cubesPerTriangleEdge?: number;
  padding?: [number, number];
  loopFrames?: number;
  lineWidth?: number;
  lineColor?: string;
  cubeColors?: [string, string, string];
}

class PenroseTriangle {
  private triangleEdge: number;
  private cubeEdge: number;
  private cubesPerTriangleEdge: number;
  private padding: [number, number];
  private loopFrames: number;
  private lineWidth: number;
  private lineColor: string;
  private cubeColors: [string, string, string];

  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private triangleHeight: number;
  private ch: number;
  private chb: number;
  private finc: number;
  private vinc1: [number, number];
  private vinc2: [number, number];
  private cubeMid: number;
  private v: Float64Array;
  private vt: Float64Array;
  private frame: number;
  private animationId: number | null = null;
  private isPaused: boolean = false;
  private pauseFrames: number = 0;

  constructor(
    canvas: HTMLCanvasElement,
    {
      triangleEdge = 300,
      cubeEdge = 30,
      cubesPerTriangleEdge = 6,
      padding = [50.5, 0.5],
      loopFrames = 100,
      lineWidth = 3,
      lineColor = '#0041a3',
      cubeColors = ['#4f9bf7', '#c0d8fc', '#87b7ff']
    }: PenroseCanvasProps = {}
  ) {
    // set options
    this.triangleEdge = triangleEdge;
    this.cubeEdge = cubeEdge;
    this.cubesPerTriangleEdge = cubesPerTriangleEdge;
    this.padding = [padding[0], padding[1]];
    this.loopFrames = loopFrames;
    this.lineWidth = lineWidth;
    this.lineColor = lineColor;
    this.cubeColors = [cubeColors[0], cubeColors[1], cubeColors[2]];

    // prepare graphics context
    this.canvas = canvas;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.context = ctx;
    this.context.lineJoin = 'round';
    this.context.lineWidth = this.lineWidth;
    this.context.strokeStyle = this.lineColor;

    // precalculate lengths and cube coordinates
    this.triangleHeight = this.triangleEdge * Math.sqrt(3) / 2;
    this.ch = this.cubeEdge * Math.sqrt(3) / 2;
    this.chb = this.cubeEdge / 2;

    // Initialize arrays
    this.v = new Float64Array(6 * this.cubesPerTriangleEdge);
    this.vt = new Float64Array(6 * this.cubesPerTriangleEdge);
    this.cubeMid = 0;
    this.finc = 0;
    this.vinc1 = [0, 0];
    this.vinc2 = [0, 0];

    this.calculateCubesCoords();

    // start at frame 0
    this.frame = 0;
  }

  // calculates coordinates for the cubes with the established parameters
  private calculateCubesCoords() {
    // triangle vertices
    const va = [                                           // bottom-left
      this.padding[0],
      this.triangleEdge + this.padding[1]
    ];
    const vb = [                                           // bottom-right
      this.triangleEdge + this.padding[0],
      this.triangleEdge + this.padding[1]
    ];
    const vc = [                                           // top
      this.triangleEdge / 2.0 + this.padding[0],
      this.triangleEdge - this.triangleHeight + this.padding[1]
    ];

    const minc = this.cubesPerTriangleEdge * this.loopFrames;
    this.finc = this.triangleEdge / minc;   // length increment for a frame
    this.vinc1 = [                          // increment vector along the right edge
      (vc[0] - vb[0]) / minc,
      (vc[1] - vb[1]) / minc
    ];
    this.vinc2 = [                          // vector increment along the left edge
      (va[0] - vc[0]) / minc,
      (va[1] - vc[1]) / minc
    ];

    // cubes' coordinates
    this.cubeMid = Math.floor((this.cubesPerTriangleEdge - 1) / 2);         // the 1st cube to draw
    const inc = this.triangleEdge / this.cubesPerTriangleEdge;          // separation between cubes
    let j = 0;

    for (let i = this.cubeMid; i < this.cubesPerTriangleEdge; ++i) {  // bottom-right
      this.v[j++] = va[0] + inc * i;
      this.v[j++] = va[1];
    }

    let vdir = [                                      // right edge Euclidean vector
      (vc[0] - vb[0]) / this.cubesPerTriangleEdge,
      (vc[1] - vb[1]) / this.cubesPerTriangleEdge
    ];
    for (let i = 0; i < this.cubesPerTriangleEdge; ++i) {             // right edge
      this.v[j++] = vb[0] + vdir[0] * i;
      this.v[j++] = vb[1] + vdir[1] * i;
    }

    vdir = [                                          // left edge vector
      (va[0] - vc[0]) / this.cubesPerTriangleEdge,
      (va[1] - vc[1]) / this.cubesPerTriangleEdge
    ];
    for (let i = 0; i < this.cubesPerTriangleEdge; ++i) {             // left edge
      this.v[j++] = vc[0] + vdir[0] * i;
      this.v[j++] = vc[1] + vdir[1] * i;
    }

    for (let i = 0; i < this.cubeMid; ++i) {                          // bottom-left
      this.v[j++] = va[0] + inc * i;
      this.v[j++] = va[1];
    }
  }

  // calculate cubes' positions for the current frame
  private updateCubesPositions() {
    // length increments for current frame
    const inc = this.finc * this.frame;
    const inc1X = this.vinc1[0] * this.frame;
    const inc1Y = this.vinc1[1] * this.frame;
    const inc2X = this.vinc2[0] * this.frame;
    const inc2Y = this.vinc2[1] * this.frame;

    let j = 0;
    for (let i = this.cubeMid; i < this.cubesPerTriangleEdge; ++i) {  // bottom-right
      this.vt[j] = this.v[j++] + inc;
      this.vt[j] = this.v[j++];
    }
    for (let i = 0; i < this.cubesPerTriangleEdge; ++i) {             // right edge
      this.vt[j] = this.v[j++] + inc1X;
      this.vt[j] = this.v[j++] + inc1Y;
    }
    for (let i = 0; i < this.cubesPerTriangleEdge; ++i) {             // left edge
      this.vt[j] = this.v[j++] + inc2X;
      this.vt[j] = this.v[j++] + inc2Y;
    }
    for (let i = 0; i < this.cubeMid; ++i) {                          // bottom-left
      this.vt[j] = this.v[j++] + inc;
      this.vt[j] = this.v[j++];
    }
  }

  // draw the triangle
  private drawTriangle() {
    this.drawCubePart1(this.vt[0], this.vt[1]);
    let j = 2;
    while (j < this.vt.length) {
      this.drawCube(this.vt[j++], this.vt[j++]);
    }
    this.drawCubePart2(this.vt[0], this.vt[1]);
  }

  // draw the whole cube, centered at (x, y)
  private drawCube(x: number, y: number) {
    this.drawCubePart1(x, y);
    this.drawCubePart2(x, y);
  }

  // draw face 0
  private drawCubePart1(x: number, y: number) {
    this.drawCubeSide(
      x, y,
      x + this.chb, y - this.ch,
      x + this.cubeEdge, y,
      x + this.chb, y + this.ch,
      this.cubeColors[0]
    );
  }

  // draw faces 1 and 2
  private drawCubePart2(x: number, y: number) {
    this.drawCubeSide(
      x, y,
      x - this.cubeEdge, y,
      x - this.chb, y - this.ch,
      x + this.chb, y - this.ch,
      this.cubeColors[1]
    );
    this.drawCubeSide(
      x, y,
      x + this.chb, y + this.ch,
      x - this.chb, y + this.ch,
      x - this.cubeEdge, y,
      this.cubeColors[2]
    );
  }

  private drawCubeSide(
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    color: string
  ) {
    this.context.beginPath();
    this.context.moveTo(x0, y0);
    this.context.lineTo(x1, y1);
    this.context.lineTo(x2, y2);
    this.context.lineTo(x3, y3);
    this.context.closePath();
    this.context.fillStyle = color;
    // this.context.stroke(); // Commented out to remove outline
    this.context.fill();
  }

  render() {
    // calculate cube positions 
    this.updateCubesPositions();

    // clear canvas and draw
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Save the current context state
    this.context.save();

    // Rotate the canvas 90 degrees clockwise (to the right)
    // Move to center of canvas, rotate, then translate back
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    this.context.translate(centerX, centerY);
    this.context.rotate(Math.PI / 2); // 90 degrees in radians
    this.context.translate(-centerX, -centerY);

    this.drawTriangle();

    // Restore the context state
    this.context.restore();

    // decrement current frame (reverse direction)
    if (this.isPaused) {
      // Count pause frames
      this.pauseFrames++;
      if (this.pauseFrames >= 30) { // Pause for ~0.5 seconds at 60fps
        this.isPaused = false;
        this.pauseFrames = 0;
      }
    } else {
      if (--this.frame < 0) {
        this.frame = this.loopFrames - 1;
        this.isPaused = true; // Start pause when loop completes
      }
    }
  }

  // 'renderLoop(timestamp)' is invoked at every repaint
  private renderLoop = () => {
    this.render();
    this.animationId = requestAnimationFrame(this.renderLoop);
  }

  // call 'start()' to begin the animation
  start() {
    this.animationId = requestAnimationFrame(this.renderLoop);
  }

  // stop the animation
  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
}

const PenroseCanvas = (props: PenroseCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const triangleRef = useRef<PenroseTriangle | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Get accent color from CSS variables (theme system)
    const accentColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent')
      .trim();

    // Convert the accent color to rgba with different opacities for the cube faces
    const rgbaAccent = hexToRgba(accentColor, 0.4);
    const rgbaFace1 = hexToRgba(accentColor, 0.28);
    const rgbaFace2 = hexToRgba(accentColor, 0.4);
    const rgbaFace3 = hexToRgba(accentColor, 0.15);

    // Scale down for the loading widget
    const scaledProps = {
      ...props,
      triangleEdge: 80,
      cubeEdge: 15,
      cubesPerTriangleEdge: 3,
      padding: [10, 10] as [number, number],
      loopFrames: 100,
      lineWidth: 1,
      lineColor: rgbaAccent,
      cubeColors: [rgbaFace1, rgbaFace2, rgbaFace3] as [string, string, string]
    };

    // Stop any existing animation before creating new one
    if (triangleRef.current) {
      triangleRef.current.stop();
    }

    triangleRef.current = new PenroseTriangle(canvasRef.current, scaledProps);
    triangleRef.current.start();

    // Handle visibility changes
    const handleVisibilityChange = () => {
      if (document.hidden) {
        triangleRef.current?.stop();
      } else {
        triangleRef.current?.start();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Listen for theme changes via custom event or data-theme attribute changes
    const handleThemeChange = () => {
      // Re-trigger effect by forcing a component update
      // This will be handled by the data-theme attribute observer
    };

    // Watch for theme changes on the body element
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          // Theme changed, recreate the triangle with new colors
          const newAccentColor = getComputedStyle(document.documentElement)
            .getPropertyValue('--color-accent')
            .trim();

          const newRgbaAccent = hexToRgba(newAccentColor, 0.4);
          const newRgbaFace1 = hexToRgba(newAccentColor, 0.28);
          const newRgbaFace2 = hexToRgba(newAccentColor, 0.4);
          const newRgbaFace3 = hexToRgba(newAccentColor, 0.15);

          const newScaledProps = {
            ...props,
            triangleEdge: 80,
            cubeEdge: 15,
            cubesPerTriangleEdge: 3,
            padding: [10, 10] as [number, number],
            loopFrames: 100,
            lineWidth: 1,
            lineColor: newRgbaAccent,
            cubeColors: [newRgbaFace1, newRgbaFace2, newRgbaFace3] as [string, string, string]
          };

          if (triangleRef.current && canvasRef.current) {
            triangleRef.current.stop();
            triangleRef.current = new PenroseTriangle(canvasRef.current, newScaledProps);
            triangleRef.current.start();
          }
        }
      });
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    return () => {
      triangleRef.current?.stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      observer.disconnect();
    };
  }, [props.lineColor, props.cubeColors]);

  return (
    <canvas
      ref={canvasRef}
      width={100}
      height={110}
      style={{
        display: 'block'
      }}
    />
  );
};

// Helper function to convert hex/rgb colors to rgba with specified opacity
const hexToRgba = (color: string, opacity: number): string => {
  // If already rgba, replace opacity
  if (color.startsWith('rgba')) {
    return color.replace(/[\d.]+\)$/g, `${opacity})`);
  }

  // If rgb, convert to rgba
  if (color.startsWith('rgb')) {
    return color.replace('rgb', 'rgba').replace(')', `, ${opacity})`);
  }

  // If hex, convert to rgba
  const hex = color.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
};

export default PenroseCanvas;
