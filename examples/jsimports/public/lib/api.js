export async function fetchGreeting(name) {
  await new Promise(r => setTimeout(r, 100));
  return { greeting: `Hello, ${name}!`, timestamp: Date.now() };
}

export async function fetchNumber() {
  await new Promise(r => setTimeout(r, 50));
  return { value: Math.floor(Math.random() * 100) + 1 };
}
