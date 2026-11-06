/**
 * @file src/content/handles.ts
 * @description Element handle registry for the VoxPilot content script.
 *
 * Maps stable handle strings (e.g. "e42") to live DOM elements.
 *
 * Design decisions:
 * - Handles are assigned per snapshot cycle. They are NOT persisted across
 *   snapshots — a new snapshot resets the registry.
 * - Handles are stored only in the content script memory (never in page DOM
 *   attributes), preventing detection by page scripts. (SRS finding #9)
 * - WeakRef is used to avoid preventing GC of removed elements.
 */

/** Regex that valid handle strings must match. */
export const HANDLE_PATTERN = /^e\d+$/;

/**
 * Registry that maps handle IDs to DOM element WeakRefs.
 * Reset at the start of each snapshot build.
 */
export class HandleRegistry {
  private registry = new Map<string, WeakRef<Element>>();
  private counter = 0;

  /**
   * Register a DOM element and return its handle string.
   * If the element was already registered in this cycle, returns the existing handle.
   *
   * @param el - The DOM element to register.
   * @returns Handle string like "e0", "e1", etc.
   */
  register(el: Element): string {
    // Check if element is already registered (identity check by iterating)
    for (const [handle, ref] of this.registry.entries()) {
      if (ref.deref() === el) return handle;
    }

    const handle = `e${this.counter++}`;
    this.registry.set(handle, new WeakRef(el));
    return handle;
  }

  /**
   * Resolve a handle string to a live DOM element.
   *
   * @param handle - Handle string (e.g. "e42").
   * @returns The DOM element, or null if the element was GC'd or handle is invalid.
   */
  resolve(handle: string): Element | null {
    if (!HANDLE_PATTERN.test(handle)) return null;
    const ref = this.registry.get(handle);
    return ref?.deref() ?? null;
  }

  /**
   * Reset the registry for a new snapshot cycle.
   * Must be called at the start of each SnapshotBuilder.build() call.
   */
  reset(): void {
    this.registry.clear();
    this.counter = 0;
  }

  /** Number of registered elements. */
  get size(): number {
    return this.registry.size;
  }
}

