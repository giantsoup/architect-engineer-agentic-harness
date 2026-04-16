import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface NeoBlessedModule {
  box(options: BlessedBoxOptions): BlessedBox;
  screen(options: BlessedScreenOptions): BlessedScreen;
}

export interface BlessedKey {
  ctrl?: boolean | undefined;
  full?: string | undefined;
  name?: string | undefined;
  sequence?: string | undefined;
  shift?: boolean | undefined;
}

export interface BlessedNodeStyle {
  bg?: string | undefined;
  border?: {
    fg?: string | undefined;
  };
  fg?: string | undefined;
}

export interface BlessedBoxOptions {
  border?: "line" | undefined;
  height?: number | string | undefined;
  hidden?: boolean | undefined;
  label?: string | undefined;
  left?: number | string | undefined;
  parent?: BlessedScreen | undefined;
  style?: BlessedNodeStyle | undefined;
  tags?: boolean | undefined;
  top?: number | string | undefined;
  width?: number | string | undefined;
}

export interface BlessedBox {
  height: number | string;
  hidden?: boolean | undefined;
  left: number | string;
  setContent(content: string): void;
  setLabel(label: string): void;
  show(): void;
  hide(): void;
  style?: BlessedNodeStyle | undefined;
  top: number | string;
  width: number | string;
}

export interface BlessedScreenOptions {
  autoPadding?: boolean | undefined;
  fullUnicode?: boolean | undefined;
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
  smartCSR?: boolean | undefined;
  title?: string | undefined;
}

export interface BlessedScreen {
  destroy(): void;
  height: number;
  key(
    keys: string | readonly string[],
    handler: (character: string, key: BlessedKey) => void,
  ): void;
  on(eventName: "resize", handler: () => void): void;
  render(): void;
  title?: string | undefined;
  width: number;
}

export function createBlessedScreen(
  options: BlessedScreenOptions,
): BlessedScreen {
  return loadNeoBlessed().screen(options);
}

export function createBlessedBox(options: BlessedBoxOptions): BlessedBox {
  return loadNeoBlessed().box(options);
}

function loadNeoBlessed(): NeoBlessedModule {
  return require("@blessed/neo-blessed") as NeoBlessedModule;
}
