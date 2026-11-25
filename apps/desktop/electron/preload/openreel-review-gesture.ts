type ReviewGestureSurface = Pick<Window & typeof globalThis, "HTMLButtonElement" | "addEventListener" | "setTimeout">;

interface ReviewButton {
  button: HTMLButtonElement;
  id: string;
}

function enabledReviewId(button: HTMLButtonElement): string | undefined {
  if (!button.isConnected || button.matches(":disabled")) return undefined;
  return button.dataset.piOpenreelConfirm || undefined;
}

/**
 * In the isolated preload, bind one approval to a native activation of the
 * exact review button. Mouse and touch presses must start on that same
 * button and proposal; a native keyboard/assistive click has no press.
 */
export function installOpenReelReviewGesture(surface: ReviewGestureSurface): (id: unknown) => boolean {
  let press: (ReviewButton & { pointerId: number }) | undefined;
  let click: (ReviewButton & { event: MouseEvent }) | undefined;

  function eventButton(event: Event): ReviewButton | undefined {
    const button = event.composedPath().find(target => target instanceof surface.HTMLButtonElement);
    if (!button) return undefined;
    const id = enabledReviewId(button);
    return id ? { button, id } : undefined;
  }

  surface.addEventListener("pointerdown", event => {
    if (!event.isTrusted) return;
    const target = event.isPrimary && event.button === 0 ? eventButton(event) : undefined;
    press = target ? { ...target, pointerId: event.pointerId } : undefined;
  }, true);
  surface.addEventListener("pointercancel", event => {
    if (event.isTrusted) press = undefined;
  }, true);
  const clear = (event: Event) => {
    if (event.isTrusted) {
      press = undefined;
      click = undefined;
    }
  };
  surface.addEventListener("blur", clear);
  surface.addEventListener("pagehide", clear);

  surface.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const pointer = press;
    press = undefined;
    click = undefined;
    const target = eventButton(event);
    if (!target || event.button !== 0) return;
    if (event.detail !== 0 &&
        (!pointer || pointer.button !== target.button || pointer.id !== target.id ||
         ("pointerId" in event && pointer.pointerId !== event.pointerId))) {
      return;
    }
    const eligible = { ...target, event };
    click = eligible;
    surface.setTimeout(() => {
      if (click === eligible) click = undefined;
    }, 0);
  }, true);

  return id => {
    const activation = click;
    click = undefined;
    return activation !== undefined && activation.id === id &&
      activation.event.eventPhase !== Event.NONE && enabledReviewId(activation.button) === id;
  };
}
