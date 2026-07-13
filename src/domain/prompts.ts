/**
 * Stage Prompts — Smart Auto-Pipeline
 *
 * Prompt templates for each pipeline stage with variable interpolation.
 * Reflect stage mandates structured JSON output for pass/fail decisions.
 *
 * @module domain/prompts
 */

export type StageName = "plan" | "execute" | "reflect" | "fix";

export interface StagePrompt {
  system: string;
  user: string;
}

/**
 * Prompt templates keyed by stage name.
 */
export const STAGE_PROMPTS: Record<StageName, StagePrompt> = {
  plan: {
    system: [
      "You are a planning assistant. Analyze the user's request and produce a clear,",
      "step-by-step execution plan. Break complex tasks into atomic steps.",
      "Identify dependencies, constraints, and potential failure points.",
      "Output the plan as numbered steps with brief explanations.",
    ].join(" "),
    user: [
      "Create a detailed execution plan for the following request.\n",
      "Request: {original_request}",
    ].join(""),
  },

  execute: {
    system: [
      "You are a capable assistant. Execute the given task accurately and completely.",
      "Follow any provided plan precisely. Produce clear, well-structured output.",
    ].join(" "),
    user: ["{plan_context}\n", "Request: {original_request}"].join(""),
  },

  reflect: {
    system: [
      "You are a quality reviewer. Evaluate the execution output against the original request.",
      "You MUST respond with a JSON object in exactly this format:\n",
      '{"status":"pass","confirmation":"<brief explanation of why the output satisfies the request>"}\n',
      "OR\n",
      '{"status":"fail","issues":["<issue 1>","<issue 2>"],"corrected":"<corrected output>"}\n',
      "Be strict: only mark pass if the output fully satisfies the request.",
      "If there are any issues, omissions, or errors, mark as fail and provide a corrected version.",
    ].join(" "),
    user: [
      "Original request: {original_request}\n\n",
      "Execution output:\n{execution_response}\n\n",
      "Evaluate the output and respond with the required JSON format.",
    ].join(""),
  },

  fix: {
    system: [
      "You are a corrective assistant. The previous execution had issues identified during review.",
      "Apply the corrections and improvements specified in the reflection.",
      "Produce a final, polished output that addresses all identified issues.",
    ].join(" "),
    user: [
      "Original request: {original_request}\n\n",
      "Reflection feedback:\n{reflection_response}\n\n",
      "Produce the corrected output.",
    ].join(""),
  },
};

/**
 * [A-06 FIX] Escape template delimiters in user-supplied values before
 * interpolation. Without this, a user input like "{system_instruction}"
 * or "{{admin_override}}" would be treated as a template variable and
 * potentially replaced in a second interpolation pass, enabling template
 * injection attacks.
 */
function escapeTemplateDelimiters(value: string): string {
  return value.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/**
 * Interpolate template variables in a prompt string.
 * Variables use {variable_name} syntax.
 *
 * [A-06 FIX] User-supplied variable values are escaped before substitution
 * to prevent template injection (a value containing `{foo}` would otherwise
 * be treated as a template variable on subsequent passes).
 *
 * @param template - Template string with {variable} placeholders
 * @param variables - Key-value pairs to substitute
 * @returns Interpolated string
 */
export function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in variables)) return match;
    // Escape braces in the replacement value to prevent template injection
    const escaped = variables[key].replace(/\{/g, "\\{").replace(/\}/g, "\\}");
    return escaped;
  });
}

/**
 * Render a stage prompt with the given variables.
 *
 * @param stage - The pipeline stage name
 * @param variables - Variable values for interpolation
 * @returns Rendered system and user prompt strings
 */
export function renderPrompt(stage: StageName, variables: Record<string, string>): StagePrompt {
  const template = STAGE_PROMPTS[stage];
  if (!template) {
    throw new Error(`Unknown stage: ${stage}`);
  }
  return {
    system: interpolate(template.system, variables),
    user: interpolate(template.user, variables),
  };
}
