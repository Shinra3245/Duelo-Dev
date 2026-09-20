export function protectActiveMatchUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}
