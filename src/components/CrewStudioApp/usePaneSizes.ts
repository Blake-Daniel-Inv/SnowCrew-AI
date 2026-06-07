// Pane size state + persistence, pointer-drag and arrow-key resize, plus
// the aria-prop helper for resize separators.
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export type ResizePane = 'left' | 'right' | 'bottom' | 'assistant';
export type PaneSizes = { left: number; right: number; bottom: number; assistant: number };

const paneSizesStorageKey = 'crewai-studio-pane-sizes';
const defaultPaneSizes: PaneSizes = { left: 240, right: 360, bottom: 320, assistant: 320 };
const paneLimits = {
  left: { min: 180, max: 520 },
  right: { min: 280, max: 640 },
  bottom: { min: 180, max: 720 },
  // assistant is the height of the Workflow Assistant panel inside the
  // left sidebar. Cap matches a tall-ish drawer; floor leaves enough
  // room for the textarea + button row.
  assistant: { min: 160, max: 720 },
} satisfies Record<ResizePane, { min: number; max: number }>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readStoredPaneSizes(): PaneSizes {
  if (typeof window === 'undefined') return defaultPaneSizes;
  try {
    const raw = window.localStorage.getItem(paneSizesStorageKey);
    if (!raw) return defaultPaneSizes;
    const parsed = JSON.parse(raw) as Partial<PaneSizes>;
    return {
      left: typeof parsed.left === 'number' ? parsed.left : defaultPaneSizes.left,
      right: typeof parsed.right === 'number' ? parsed.right : defaultPaneSizes.right,
      bottom: typeof parsed.bottom === 'number' ? parsed.bottom : defaultPaneSizes.bottom,
      assistant: typeof parsed.assistant === 'number' ? parsed.assistant : defaultPaneSizes.assistant,
    };
  } catch {
    return defaultPaneSizes;
  }
}

export function usePaneSizes(opts: {
  appBodyRef: RefObject<HTMLDivElement | null>;
  canvasAreaRef: RefObject<HTMLElement | null>;
  leftOpen: boolean;
  rightOpen: boolean;
}) {
  const { appBodyRef, canvasAreaRef, leftOpen, rightOpen } = opts;
  const [paneSizes, setPaneSizes] = useState<PaneSizes>(defaultPaneSizes);
  const [paneSizesLoaded, setPaneSizesLoaded] = useState(false);

  /* --- pane resizing --- */
  useEffect(() => {
    // Read localStorage post-hydration. We can't use a lazy useState
    // initializer here because that would create an SSR/CSR mismatch
    // (server renders defaults, client would render stored sizes).
    // React 19's stricter rule flags this — the eslint-disable is the
    // documented workaround for client-only state hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPaneSizes((current) => ({ ...current, ...readStoredPaneSizes() }));
    setPaneSizesLoaded(true);
  }, []);

  useEffect(() => {
    if (!paneSizesLoaded || typeof window === 'undefined') return;
    window.localStorage.setItem(paneSizesStorageKey, JSON.stringify(paneSizes));
  }, [paneSizes, paneSizesLoaded]);

  function maxPaneSize(pane: ResizePane, current: PaneSizes): number {
    const limit = paneLimits[pane];
    if (pane === 'bottom') {
      const canvasHeight = canvasAreaRef.current?.getBoundingClientRect().height || window.innerHeight;
      return Math.max(limit.min, Math.min(limit.max, canvasHeight - 80));
    }
    if (pane === 'assistant') {
      // Assistant lives inside the left sidebar. Its max is the sidebar
      // height minus reserved space for the upper sections (palette +
      // crews) and the sidebar footer beneath it.
      const sidebarHeight = appBodyRef.current?.getBoundingClientRect().height || window.innerHeight;
      const reservedAbove = 280;   // palette + crews list
      const reservedBelow = 72;    // sidebar-footer height
      return Math.max(limit.min, Math.min(limit.max, sidebarHeight - reservedAbove - reservedBelow));
    }

    const bodyWidth = appBodyRef.current?.getBoundingClientRect().width || window.innerWidth;
    const otherPaneWidth =
      pane === 'left'
        ? rightOpen ? current.right : 0
        : leftOpen ? current.left : 0;
    return Math.max(limit.min, Math.min(limit.max, bodyWidth - otherPaneWidth - 360));
  }

  function resizePane(pane: ResizePane, rawSize: number) {
    setPaneSizes((current) => {
      const limit = paneLimits[pane];
      const nextSize = clamp(rawSize, limit.min, maxPaneSize(pane, current));
      return { ...current, [pane]: nextSize };
    });
  }

  // Arrow-key keyboard support for the resize separators. Each press
  // nudges the pane size by 16px. We respect the same clamp logic as
  // pointer-drag by routing through resizePane.
  const PANE_KEY_STEP = 16;
  function handlePaneResizeKey(
    pane: ResizePane,
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) {
    const isHorizontalSeparator = pane === 'bottom' || pane === 'assistant';
    const positiveKeys = isHorizontalSeparator ? ['ArrowUp'] : ['ArrowRight'];
    const negativeKeys = isHorizontalSeparator ? ['ArrowDown'] : ['ArrowLeft'];
    const current = paneSizes[pane];

    if (positiveKeys.includes(event.key)) {
      event.preventDefault();
      resizePane(pane, current + PANE_KEY_STEP);
    } else if (negativeKeys.includes(event.key)) {
      event.preventDefault();
      resizePane(pane, current - PANE_KEY_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resizePane(pane, paneLimits[pane].min);
    } else if (event.key === 'End') {
      event.preventDefault();
      resizePane(pane, paneLimits[pane].max);
    }
  }

  function paneAriaProps(pane: ResizePane) {
    const limit = paneLimits[pane];
    const current = paneSizes[pane];
    return {
      role: 'separator' as const,
      'aria-orientation':
        pane === 'bottom' || pane === 'assistant' ? ('horizontal' as const) : ('vertical' as const),
      'aria-valuemin': limit.min,
      'aria-valuemax': limit.max,
      'aria-valuenow': Math.round(current),
    };
  }

  function startPaneResize(pane: ResizePane, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const body = document.body;
    body.classList.add('is-pane-resizing');
    body.style.cursor =
      pane === 'bottom' || pane === 'assistant' ? 'row-resize' : 'col-resize';

    const onMove = (moveEvent: PointerEvent) => {
      if (pane === 'left') {
        const rect = appBodyRef.current?.getBoundingClientRect();
        resizePane('left', moveEvent.clientX - (rect?.left || 0));
        return;
      }

      if (pane === 'right') {
        const rect = appBodyRef.current?.getBoundingClientRect();
        resizePane('right', (rect?.right || window.innerWidth) - moveEvent.clientX);
        return;
      }

      if (pane === 'assistant') {
        // Handle sits on the panel's TOP edge; dragging up grows the
        // panel. The panel's bottom edge is fixed at (sidebar bottom -
        // footer height), so the panel's height = (panel bottom - cursor Y).
        const rect = appBodyRef.current?.getBoundingClientRect();
        const footerHeight = 72;
        const sidebarBottom = rect?.bottom || window.innerHeight;
        const panelBottom = sidebarBottom - footerHeight;
        resizePane('assistant', panelBottom - moveEvent.clientY);
        return;
      }

      const rect = canvasAreaRef.current?.getBoundingClientRect();
      resizePane('bottom', (rect?.bottom || window.innerHeight) - moveEvent.clientY);
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      body.classList.remove('is-pane-resizing');
      body.style.cursor = '';
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  return {
    paneSizes,
    startPaneResize,
    handlePaneResizeKey,
    paneAriaProps,
  };
}
