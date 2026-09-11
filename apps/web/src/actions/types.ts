import type { MutableRefObject } from "react";
import type { TAction } from "./definitions";
import { ACTIONS } from "./definitions";

export type { TAction };

export type TActionArgsMap = {
	"seek-forward": { seconds: number } | undefined;
	"seek-backward": { seconds: number } | undefined;
	"jump-forward": { seconds: number } | undefined;
	"jump-backward": { seconds: number } | undefined;
	"remove-media-asset": { projectId: string; assetId: string };
	"remove-media-assets": { projectId: string; assetIds: string[] };
};

type TKeysWithValueUndefined<T> = {
	[K in keyof T]: undefined extends T[K] ? K : never;
}[keyof T];

export type TActionWithArgs = keyof TActionArgsMap;

export type TActionWithOptionalArgs =
	| TActionWithNoArgs
	| TKeysWithValueUndefined<TActionArgsMap>;

export type TActionWithNoArgs = Exclude<TAction, TActionWithArgs>;

const ACTION_SET: ReadonlySet<string> = new Set(Object.keys(ACTIONS));
const ACTION_WITH_ARGS_SET: ReadonlySet<string> = new Set(
	Object.keys({
		"seek-forward": 0,
		"seek-backward": 0,
		"jump-forward": 0,
		"jump-backward": 0,
		"remove-media-asset": 0,
		"remove-media-assets": 0,
	} satisfies Record<TActionWithArgs, number>),
);

/**
 * Type guard for persisted/imported action names.
 *
 * Only actions that may be invoked without arguments are accepted, so a
 * restored keybinding can never point at an action that needs args the
 * keypress path cannot supply.
 */
export function isActionWithOptionalArgs(
	value: unknown,
): value is TActionWithOptionalArgs {
	if (typeof value !== "string") return false;
	if (!ACTION_SET.has(value)) return false;
	return !ACTION_WITH_ARGS_SET.has(value);
}

export type TArgOfAction<A extends TAction> = A extends TActionWithArgs
	? TActionArgsMap[A]
	: undefined;

export type TActionFunc<A extends TAction> = A extends TActionWithArgs
	? (arg: TArgOfAction<A>, trigger?: TInvocationTrigger) => void
	: (_?: undefined, trigger?: TInvocationTrigger) => void;

export type TInvocationTrigger = "keypress" | "mouseclick";

export type TBoundActionList = {
	[A in TAction]?: Array<TActionFunc<A>>;
};

export type TActionHandlerOptions =
	| MutableRefObject<boolean>
	| boolean
	| undefined;
