/** Shared validation for Goal creation and partial updates. */
import { Type } from "typebox";

export interface GoalSettings {
	objective: string;
	criteria: string[];
	verificationCommands: string[];
	maxContinuations: number;
	maxMinutes: number;
	maxOutputTokens: number;
}
export type GoalPatch = Partial<GoalSettings>;
const optionalFields = {
	criteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 30 })),
	verificationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 10 })),
	maxContinuations: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	maxMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
	maxOutputTokens: Type.Optional(Type.Integer({ minimum: 100, maximum: 2000000 })),
};
export const StartParams = Type.Object({ objective: Type.String({ minLength: 1, maxLength: 12000 }), ...optionalFields }, { additionalProperties: false });
export const UpdateParams = Type.Object({
	goalId: Type.String({ minLength: 1 }),
	objective: Type.Optional(Type.String({ minLength: 1, maxLength: 12000 })),
	...optionalFields,
}, { additionalProperties: false });

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be nonempty text, at most ${max} characters.`);
	return value.trim();
}
function list(value: unknown, field: string, min: number, max: number): string[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} requires ${min}-${max} strings.`);
	return value.map(item => text(item, field, 4000));
}
function number(value: unknown, field: string, min: number, max: number, integer = true): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${field} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
	return value;
}
/** Validate every supplied value before changing live state. Counters are never reset here. */
export function goalSettings(patch: GoalPatch, previous?: GoalSettings): GoalSettings {
	const objective = text(patch.objective ?? previous?.objective, "objective", 12000);
	return {
		objective,
		criteria: list(patch.criteria ?? previous?.criteria ?? [objective], "criteria", 1, 30),
		verificationCommands: list(patch.verificationCommands ?? previous?.verificationCommands ?? [], "verificationCommands", 0, 10),
		maxContinuations: number(patch.maxContinuations ?? previous?.maxContinuations ?? 20, "maxContinuations", 1, 200),
		maxMinutes: number(patch.maxMinutes ?? previous?.maxMinutes ?? 60, "maxMinutes", 1, 1440, false),
		maxOutputTokens: number(patch.maxOutputTokens ?? previous?.maxOutputTokens ?? 100000, "maxOutputTokens", 100, 2000000),
	};
}
