/**
 * Roles resolved to plain colours, per theme, for code that cannot read CSS:
 * a canvas renderer, the Electron main process painting a window before any
 * stylesheet loads, a chart library, an OG image.
 *
 * A wash (`color-mix(in srgb, X p%, transparent)`) is X at p% opacity, so it
 * resolves to an 8-digit hex; everything else is 6-digit hex.
 */
import { colorRoles, palette, type ColorRole, type ColorRoleName, type Paint, type PaletteName, type ThemeName } from './tokens.js';

interface Rgba {
  hex: string; // #rrggbb
  alpha: number; // 0..1
}

const fromPaint = (paint: Paint): Rgba =>
  typeof paint === 'string'
    ? { hex: palette[paint as PaletteName], alpha: 1 }
    : { hex: palette[paint.hue], alpha: paint.percent / 100 };

function resolveRole(name: string, theme: ThemeName, seen: Set<string> = new Set()): Rgba {
  if (seen.has(name)) throw new Error(`colour role --${name} refers to itself`);
  seen.add(name);
  const role = (colorRoles as Record<string, ColorRole>)[name];
  if (!role) throw new Error(`no colour role --${name}`);
  if ('both' in role) return { hex: palette[role.both], alpha: 1 };
  if ('alias' in role) return resolveRole(role.alias, theme, seen);
  if ('wash' in role) {
    const base = resolveRole(role.wash, theme, seen);
    return { hex: base.hex, alpha: base.alpha * (role.percent / 100) };
  }
  return fromPaint(theme === 'light' ? role.light : role.dark);
}

const toHex = ({ hex, alpha }: Rgba): string =>
  alpha >= 1 ? hex : `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;

/** One role in one theme, as `#rrggbb` or `#rrggbbaa`. */
export function resolveColor(role: ColorRoleName, theme: ThemeName): string {
  return toHex(resolveRole(role, theme));
}

/** Every colour role in one theme. */
export function resolveTheme(theme: ThemeName): Record<ColorRoleName, string> {
  return Object.fromEntries(Object.keys(colorRoles).map((name) => [name, toHex(resolveRole(name, theme))])) as Record<
    ColorRoleName,
    string
  >;
}
