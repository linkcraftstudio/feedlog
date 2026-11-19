// A node heading uses selection + chevron. Rows offset by the chevron column,
// so titles, list filters and pagination all share the same starting column.
export const aiTrainingListLayout = {
  root: '[--ai-training-header-padding:1.75rem] sm:[--ai-training-header-padding:2rem] [--ai-training-selection-space:2.125rem] [--ai-training-content-start:calc(var(--ai-training-header-padding)_+_16px_+_0.875rem_+_var(--ai-training-selection-space))]',
  header: 'pl-[var(--ai-training-header-padding)]',
  row: 'pl-[calc(var(--ai-training-header-padding)_+_16px_+_0.875rem)]',
  content: 'pl-[var(--ai-training-content-start)]',
}
