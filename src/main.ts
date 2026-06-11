/**
 * Landing page for the pyodide-tk dev server. Lists available examples.
 * Real application UX is per-example under examples/<name>/.
 */

const examples = [
  { name: 'tk-hello', description: 'Minimal Tk: Label + Button with -command callback' },
  { name: 'turtle-hello', description: 'Stdlib turtle graphics on a Tk Canvas' },
  { name: 'widget-gallery', description: 'Tk widget gallery: buttons, text, selection, containers, canvas' },
];

const root = document.getElementById('app');
if (root) {
  const title = document.createElement('h1');
  title.textContent = 'pyodide-tk examples';
  root.appendChild(title);

  const intro = document.createElement('p');
  intro.textContent =
    'Real Pyodide + real CPython 3.14 + real Tk widgets, painted to a canvas via em-x11.';
  root.appendChild(intro);

  const list = document.createElement('ul');
  for (const ex of examples) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/examples/${ex.name}/`;
    a.textContent = `${ex.name} — ${ex.description}`;
    li.appendChild(a);
    list.appendChild(li);
  }
  root.appendChild(list);
}
