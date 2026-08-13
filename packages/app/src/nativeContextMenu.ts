export function suppressNativeContextMenu(isProduction: boolean): () => void {
  if (!isProduction) return () => undefined;

  const preventDefault = (event: MouseEvent): void => event.preventDefault();
  window.addEventListener('contextmenu', preventDefault);
  return () => window.removeEventListener('contextmenu', preventDefault);
}
