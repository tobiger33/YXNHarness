const modifiers = ['Meta','Control','Alt','Shift'];
export const DEFAULT_SEND_SHORTCUT = {key:'Enter',meta:false,ctrl:false,alt:false,shift:false};
export const DEFAULT_STEER_SHORTCUT = {key:'Enter',meta:true,ctrl:false,alt:false,shift:false};
export function shortcutFromEvent(event) {
  if (event.isComposing || event.repeat || modifiers.includes(event.key) || event.key === 'Escape' || event.key === 'Tab') return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!['Enter', ...'abcdefghijklmnopqrstuvwxyz0123456789'].includes(key)) return null;
  if (!event.metaKey && !event.ctrlKey && !event.altKey && key !== 'Enter') return null;
  if ((event.metaKey || event.ctrlKey) && ['q','w','r','c','v','x','a','z','1'].includes(key)) return null;
  return {key,meta:!!event.metaKey,ctrl:!!event.ctrlKey,alt:!!event.altKey,shift:!!event.shiftKey};
}
export function matchesShortcut(event, shortcut) {
  return !event.isComposing && !event.repeat &&
    (event.key.length === 1 ? event.key.toLowerCase() : event.key) === shortcut.key &&
    !!event.metaKey === shortcut.meta && !!event.ctrlKey === shortcut.ctrl &&
    !!event.altKey === shortcut.alt && !!event.shiftKey === shortcut.shift;
}
export function shortcutLabel(shortcut) {
  return [shortcut.ctrl && '⌃',shortcut.alt && '⌥',shortcut.shift && '⇧',shortcut.meta && '⌘',shortcut.key === 'Enter' ? 'Enter' : shortcut.key.toUpperCase()].filter(Boolean).join(' ');
}
export function validShortcut(value) {
  if (!value || typeof value.key !== 'string' || !['meta','ctrl','alt','shift'].every(key => typeof value[key] === 'boolean')) return false;
  const parsed = shortcutFromEvent({key:value.key,metaKey:value.meta,ctrlKey:value.ctrl,altKey:value.alt,shiftKey:value.shift});
  return !!parsed && parsed.key === value.key;
}

export function sameShortcut(a, b) {
  return ['key','meta','ctrl','alt','shift'].every(key => a[key] === b[key]);
}
