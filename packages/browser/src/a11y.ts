import type { Page } from 'playwright';

export type A11yImpact = 'serious' | 'moderate' | 'minor';

export interface A11yFinding {
  readonly rule: string;
  readonly impact: A11yImpact;
  readonly message: string;
  /** A CSS path to the offending element, good enough to locate it by eye. */
  readonly selector: string;
}

export interface A11yReport {
  readonly url: string;
  readonly findings: readonly A11yFinding[];
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * The slice of the DOM the in-page checks actually use.
 *
 * Declared here rather than by adding `"DOM"` to this package's `lib`, because
 * the tsconfigs are generated from `scripts/packages.mjs` and a hand-edited
 * compiler option does not survive. It also documents the dependency exactly:
 * these eleven members are the whole contract between Tandemise and the page.
 */
interface PageElement {
  readonly tagName: string;
  readonly id: string;
  readonly parentElement: PageElement | null;
  readonly children: ArrayLike<PageElement> & Iterable<PageElement>;
  readonly childNodes: ArrayLike<PageNode> & Iterable<PageNode>;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  closest(selector: string): PageElement | null;
}
interface PageNode {
  readonly nodeType: number;
  readonly textContent: string | null;
}
interface PageStyle {
  readonly display: string;
  readonly visibility: string;
  readonly color: string;
  readonly backgroundColor: string;
  readonly fontSize: string;
  readonly fontWeight: string;
}
declare const document: {
  readonly documentElement: PageElement;
  getElementById(id: string): PageElement | null;
  querySelector(selector: string): PageElement | null;
  querySelectorAll(selector: string): ArrayLike<PageElement> & Iterable<PageElement>;
};
declare function getComputedStyle(element: PageElement): PageStyle;
declare const CSS: { escape(value: string): string };

/**
 * Cheap, dependency-free accessibility checks (MVP.md §13.2).
 *
 * Deliberately a handful of high-signal rules rather than a rules engine: this
 * exists so a QA worker notices an unlabelled control before a human does, not
 * to certify conformance. Every rule here is one a reviewer would raise anyway,
 * and each finding names an element the fixer can actually find.
 *
 * Contrast is checked only where it can be computed honestly - solid text on a
 * solid ancestor background. Images, gradients and translucency are skipped
 * rather than guessed at, because a false contrast failure trains people to
 * ignore the whole report.
 */
export async function runA11yChecks(page: Page): Promise<A11yReport> {
  const findings = await page.evaluate(collectFindings);
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
  }
  return { url: page.url(), findings, counts };
}

/** Runs inside the page. Must be self-contained - it is serialised to get there. */
function collectFindings(): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const MAX_PER_RULE = 25;

  const cssPath = (el: PageElement): string => {
    const parts: string[] = [];
    let node: PageElement | null = el;
    while (node && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
      const parent: PageElement | null = node.parentElement;
      if (parent) {
        const tag = node.tagName;
        const siblings = [...parent.children].filter((c) => c.tagName === tag);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };

  const add = (rule: string, impact: A11yImpact, message: string, el: PageElement): void => {
    if (findings.filter((f) => f.rule === rule).length >= MAX_PER_RULE) return;
    findings.push({ rule, impact, message, selector: cssPath(el) });
  };

  const isHidden = (el: PageElement): boolean => {
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden'
      || el.getAttribute('aria-hidden') === 'true';
  };

  const accessibleName = (el: PageElement): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ').trim();
      if (text) return text;
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const labelText = label?.textContent?.trim();
      if (labelText) return labelText;
    }
    const wrapping = el.closest('label')?.textContent?.trim();
    if (wrapping) return wrapping;
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return (el.textContent ?? '').trim();
  };

  if (!document.documentElement.getAttribute('lang')) {
    findings.push({
      rule: 'html-lang',
      impact: 'moderate',
      message: 'The <html> element has no lang attribute, so screen readers cannot pick a voice.',
      selector: 'html',
    });
  }

  for (const img of document.querySelectorAll('img')) {
    if (isHidden(img)) continue;
    if (img.getAttribute('alt') === null) {
      add('image-alt', 'serious',
        'Image has no alt attribute. Use alt="" if it is decorative.', img);
    }
  }

  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (isHidden(el)) continue;
    const type = el.getAttribute('type');
    if (type === 'hidden' || type === 'submit' || type === 'button') continue;
    if (!accessibleName(el)) {
      add('form-label', 'serious', 'Form control has no associated label or aria-label.', el);
    }
  }

  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (isHidden(el)) continue;
    if (!accessibleName(el)) {
      add('control-name', 'serious',
        'Interactive control has no accessible name (no text, aria-label or title).', el);
    }
  }

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => !isHidden(h));
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previous !== 0 && level > previous + 1) {
      add('heading-order', 'moderate',
        `Heading level jumps from h${previous} to h${level}.`, heading);
    }
    previous = level;
  }
  if (headings.length > 0 && !headings.some((h) => h.tagName === 'H1')) {
    findings.push({
      rule: 'heading-order',
      impact: 'minor',
      message: 'The page has headings but no h1.',
      selector: 'body',
    });
  }

  // --- contrast -------------------------------------------------------------
  const parseRgb = (value: string): [number, number, number] | null => {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
    if (!match) return null;
    // A translucent colour composites with whatever is behind it; guessing the
    // result would produce contrast failures nobody can reproduce.
    if (match[4] !== undefined && Number(match[4]) < 0.99) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const solidBackground = (el: PageElement): [number, number, number] | null => {
    let node: PageElement | null = el;
    while (node) {
      const rgb = parseRgb(getComputedStyle(node).backgroundColor);
      if (rgb) return rgb;
      node = node.parentElement;
    }
    return null;
  };

  const luminance = ([r, g, b]: [number, number, number]): number => {
    const channel = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const TEXT_SELECTOR = 'p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, button, label';
  for (const el of document.querySelectorAll(TEXT_SELECTOR)) {
    if (isHidden(el)) continue;
    // Only this element's own text: an ancestor's colour says nothing about a
    // child that overrides it.
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .join('');
    if (ownText.length === 0) continue;

    const style = getComputedStyle(el);
    const foreground = parseRgb(style.color);
    const background = solidBackground(el);
    if (!foreground || !background) continue;

    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    const ratio = (light + 0.05) / (dark + 0.05);

    const sizePx = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const isLarge = sizePx >= 24 || (bold && sizePx >= 18.66);
    const required = isLarge ? 3 : 4.5;
    if (ratio < required) {
      add('contrast', 'serious',
        `Contrast ratio ${ratio.toFixed(2)}:1 is below the ${required}:1 minimum for this text size.`,
        el);
    }
  }

  return findings;
}
