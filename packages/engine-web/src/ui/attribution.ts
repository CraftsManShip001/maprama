/**
 * Data attribution text (required by data licenses such as ODbL when shipping
 * real map data). Shows the loaded world's `attribution` lines.
 *
 * @module
 */

export class Attribution {
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = parent.ownerDocument.createElement('div');
    this.el.className = 'mpr-attrib';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  update(visible: boolean, lines: readonly string[]): void {
    const text = lines.filter(Boolean).join(' · ');
    if (this.el.textContent !== text) this.el.textContent = text;
    this.el.hidden = !visible || !text;
  }

  dispose(): void {
    this.el.remove();
  }
}
