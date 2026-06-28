export interface MotionOptions {
  /** Default preset when an element uses a bare `transition` attribute. Default: "fade". */
  preset?: "fade" | "slide" | "scale" | (string & {});
  /** Default duration in milliseconds. Default: 200. */
  duration?: number;
  /** Default easing. Default: "ease". */
  easing?: string;
  /** Animate the initial mount too (off by default — only later enters animate). */
  appear?: boolean;
}

export interface Preset {
  in: Keyframe[];
  out: Keyframe[];
}

/** Built-in keyframe presets, keyed by name. Mutate to add your own. */
export const presets: Record<string, Preset>;

/**
 * Register enter/leave transitions for Spark if/each blocks. Call once before
 * `mount()`. Opt elements in with `transition="fade|slide|scale"` (or the
 * directive form `transition:fade`).
 */
export function motion(options?: MotionOptions): void;
export default motion;
