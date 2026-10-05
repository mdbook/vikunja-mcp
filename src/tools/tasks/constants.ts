/**
 * Constants for task operations
 */

// Error message constants
export const AUTH_ERROR_MESSAGES = {
  ASSIGNEE_CREATE:
    'Assignee operations may have authentication issues with certain Vikunja API versions. ' +
    'This is a known limitation. The task was created but assignees could not be added.',
  ASSIGNEE_UPDATE:
    'Assignee operations may have authentication issues with certain Vikunja API versions. ' +
    'This is a known limitation. Other task fields were updated but assignees could not be changed.',
  ASSIGNEE_ASSIGN:
    'Vikunja refused to assign the user(s) to the task. The service token may lack permission ' +
    "for this task, or the user may not have access to the task's project.",
  ASSIGNEE_REMOVE:
    'Vikunja refused to remove the user(s) from the task. The service token may lack permission ' +
    'for this task.',
  ASSIGNEE_REMOVE_PARTIAL:
    'Assignee removal operations may have authentication issues with certain Vikunja API versions. ' +
    'This is a known limitation. New assignees were added but old assignees could not be removed.',
  ASSIGNEE_BULK_UPDATE:
    'Assignee operations may have authentication issues with certain Vikunja API versions. ' +
    'This is a known limitation that prevents bulk updating assignees.',
  LABEL_CREATE:
    'Label operations may have authentication issues with certain Vikunja API versions. ' +
    'This is a known limitation. The task was created but labels could not be added.',
  LABEL_UPDATE:
    'Label operations may have authentication issues with certain Vikunja API versions. ' +
    'This is a known limitation. Other task fields were updated but labels could not be changed.',
};

// Bulk operation constants
export const BULK_OPERATION_BATCH_SIZE = 10;
export const MAX_BULK_OPERATION_TASKS = 100;

// Repeat mode mapping for bulk update API
// Maps user-friendly string values to Vikunja API numeric codes
export const REPEAT_MODE_MAP: Record<string, number> = {
  default: 0,
  month: 1,
  from_current: 2,
} as const;