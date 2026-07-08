/** Repro: clearing an input by setting its bound var to '' */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';

const { mount, component } = await import('../src/index.js');

component('todoform', `
<input value="{draft}" oninput="{type}" />
<button onclick="{add}">Add</button>
<p>{todos.length} todos</p>
<script>
  let todos = [];
  let draft = '';
  function type(event) { draft = event.target.value; }
  function add() { todos = [...todos, draft]; draft = ''; }
</script>
`);

parseHTML('<div import="todoform"></div>', body);
await mount();
await new Promise(r => setTimeout(r, 10));

const input = body.querySelector('input');
const button = body.querySelector('button');

function fire(el, type) {
  const e = { type, target: el, currentTarget: el };
  (el._listeners[type] || []).forEach(fn => fn(e));
}

// user types "hello" — property write + input event, like a real keystroke
input.value = 'hello';
fire(input, 'input');

console.log('after typing — input.value:', JSON.stringify(input.value));

fire(button, 'click');
await new Promise(r => setTimeout(r, 10));

console.log('after add    — input.value:', JSON.stringify(input.value));
console.log('value ATTRIBUTE:', JSON.stringify(input.getAttribute('value')));
console.log(input.value === '' ? '✅ input cleared' : '❌ INPUT NOT CLEARED — bug reproduced');
