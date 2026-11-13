// Trusted diagnostic candidate; --fixture does not invoke a model.
export function borrowBook(state, userId) {
  if (!state || !Number.isInteger(state.stock) || state.stock < 0 || !Array.isArray(state.loans)
    || state.loans.some(id => typeof id !== 'string' || !id.trim()) || typeof userId !== 'string' || !userId.trim()) {
    throw new Error('INVALID_INPUT');
  }
  if (state.loans.includes(userId)) throw new Error('ALREADY_BORROWED');
  if (state.stock === 0) throw new Error('OUT_OF_STOCK');
  return { stock: state.stock - 1, loans: [...state.loans, userId] };
}
