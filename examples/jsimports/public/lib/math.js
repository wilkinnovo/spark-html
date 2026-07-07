export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }

export function factorial(n) {
  if (n < 0) return NaN;
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
