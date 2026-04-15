Produce a concise execution plan for the current task.

The plan should be readable by both the user and the Engineer.
When you are ready to finish planning, return a single JSON object for the final plan.
Do not wrap the final JSON in markdown fences.
Write the plan for a weaker Engineer model:

- keep the step list short and ordered
- name exact files and commands whenever they are knowable from the task
- use only verified file paths and directories from the workspace snapshot or tool outputs; do not guess them
- prefer concrete actions over abstract guidance
- make acceptance criteria objective and checkable
- avoid requiring broad exploration unless the task is genuinely ambiguous
