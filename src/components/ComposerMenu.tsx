// SPDX-License-Identifier: Apache-2.0
import { useRef, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Panel, useClickPopover } from "./popover";
import "./ComposerMenu.css";

export interface ComposerOption {
  value: string; label: string; detail?: string; icon?: ReactNode;
  disabled?: boolean; group?: string;
}

/** The composer's menus share placement, keyboard navigation and glass
 *  material: a popover portalled out of the card (`Panel`), above or below the
 *  chip by the room there is with that room as its `maxHeight`, and over a
 *  native browser page the page's picture first (`useMenuOverlay`, as the
 *  plan's ⋯). A pick applies and closes; Esc closes; focus goes back to the
 *  chip either way. */
export function ComposerMenu({ label, title, value, options, onChange, icon, children, chip, className }: {
  label: string; title?: string; value?: string; options: ComposerOption[];
  onChange: (value: string) => void; icon?: ReactNode; children?: ReactNode;
  /** Which chip this is (`data-chip`), for the row's sizing rules. */
  chip?: string;
  /** More classes for the chip. */
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useClickPopover(trigger, "left", "above", 304);
  return <>
    <button ref={trigger} type="button" className={`rl-composer-chip${className ? ` ${className}` : ""}`} aria-label={label} data-chip={chip}
      title={title} aria-haspopup="menu" aria-expanded={pop.open} onClick={pop.toggle}>
      {icon}<span>{children ?? label}</span><ChevronDown size={12}/>
    </button>
    {pop.open && <Panel label={label} {...pop.panelProps} className="rl-composer-menu" style={{ ...pop.panelProps.style, width: 304 }}>
      <div className="rl-composer-menu-scroll">
        <div className="rl-composer-menu-heading">{label}</div>
        {options.map((option, i) => <div key={option.value}>
          {option.group && option.group !== options[i - 1]?.group && <div className="rl-composer-menu-heading">{option.group}</div>}
          <button type="button" className="rl-composer-option" role={value === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={value === undefined ? undefined : value === option.value} disabled={option.disabled}
            onClick={() => { onChange(option.value); pop.close(); trigger.current?.focus(); }}>
            {option.icon}<span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
            {value === option.value && <Check size={14} className="rl-composer-check"/>}
          </button>
        </div>)}
      </div>
    </Panel>}
  </>;
}
