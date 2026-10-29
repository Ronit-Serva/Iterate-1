import { Role, type Message } from '@a2a-js/sdk';
export function numbersFromMessage(message: Message): number[] {
  if (message.role !== Role.ROLE_USER) throw new Error('Expected a user message');
  if (message.parts.length !== 1 || message.parts[0].content?.$case !== 'data') throw new Error('Expected one data part containing numbers');
  const input = message.parts[0].content.value;
  const numbers = input?.numbers;
  if (!Array.isArray(numbers) || numbers.length < 1 || numbers.length > 1000 || !numbers.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12)) {
    throw new Error('numbers must contain 1–1000 finite numbers with magnitude at most 1e12');
  }
  return numbers;
}
export function statistics(numbers: number[]) {
  const sum = numbers.reduce((total, value) => total + value, 0);
  return { count: numbers.length, sum, min: Math.min(...numbers), max: Math.max(...numbers), mean: sum / numbers.length };
}
