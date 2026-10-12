declare global {
namespace JSX {
  export type Element = HTMLElement;
  export interface IntrinsicElements {
    main: Record<string, unknown>; section: Record<string, unknown>; h1: Record<string, unknown>;
    h2: Record<string, unknown>; p: Record<string, unknown>; ul: Record<string, unknown>;
    li: Record<string, unknown>; strong: Record<string, unknown>; span: Record<string, unknown>;
    code: Record<string, unknown>; small: Record<string, unknown>;
  }
}
}

export function h(tag: keyof HTMLElementTagNameMap, attributes: Record<string, unknown> | null, ...children: unknown[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (key === 'className' && typeof value === 'string') element.className = value;
    else if (key === 'title' && typeof value === 'string') element.title = value;
  }
  for (const child of children.flat(Infinity)) {
    if (child instanceof Node) element.append(child);
    else if (child !== null && child !== undefined && child !== false) element.append(document.createTextNode(String(child)));
  }
  return element;
}
