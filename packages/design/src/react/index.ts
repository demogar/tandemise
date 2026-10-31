/**
 * @tandemise/design/react - accessible React components over the package's
 * stylesheet (`@tandemise/design/components.css`).
 *
 * They hold markup and accessibility, never product logic: each renders the
 * BEM classes in components.css, takes state as props and reports it as
 * data-* / aria-* attributes. React 18 and 19 are both supported (a peer
 * dependency); nothing else is imported.
 *
 *   import '@tandemise/design/tokens.css';
 *   import '@tandemise/design/base.css';
 *   import '@tandemise/design/components.css';
 *   import { Button, Dialog } from '@tandemise/design/react';
 */
export { cx, type Tone, type BadgeTone } from './cx.js';
export { Button, buttonClass, type ButtonProps, type ButtonVariant, type ButtonSize, type ButtonClassOptions } from './Button.js';
export { Badge, StatusPill, StatusDot, type BadgeProps, type StatusPillProps, type StatusDotProps } from './Badge.js';
export { Card, type CardProps } from './Card.js';
export { Icon, type IconProps, type IconName } from './Icon.js';
export { Logo, type LogoProps } from './Logo.js';
export { Field, type FieldProps, type FieldControlProps } from './Field.js';
export { Dialog, type DialogProps } from './Dialog.js';
export { useDialogLayer, trapTarget, openLayerCount, FOCUSABLE_SELECTOR, type DialogLayerOptions } from './layer.js';
export { Tabs, Tab, nextTabIndex, type TabsProps, type TabProps } from './Tabs.js';
export { Tooltip, tooltipPosition, type TooltipProps, type TooltipTriggerProps, type TooltipPlacement } from './Tooltip.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';

/** Every component this subpath exports, by name. The gallery must show each one (`npm run check:design`). */
export const COMPONENTS = ['Button', 'Badge', 'StatusPill', 'StatusDot', 'Card', 'Icon', 'Logo', 'Field', 'Dialog', 'Tabs', 'Tab', 'Tooltip', 'EmptyState'] as const;
