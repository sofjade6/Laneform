export {}; // module, requis par `declare global`

const input = document.getElementById('key') as HTMLInputElement;
const save = document.getElementById('save') as HTMLButtonElement;
const skip = document.getElementById('skip') as HTMLButtonElement;
const message = document.getElementById('message') as HTMLElement;
const pathLabel = document.getElementById('path') as HTMLElement;

function setMessage(text: string, kind: 'error' | 'ok' | 'busy' | '' = ''): void {
  message.textContent = text;
  message.className = kind ? `setup__message setup__message--${kind}` : 'setup__message';
}

void window.laneform.configPath().then((path) => {
  pathLabel.textContent = `Enregistrée dans ${path}`;
});

async function submit(): Promise<void> {
  const key = input.value.trim();
  if (key === '') {
    setMessage('Collez votre clé avant de valider.', 'error');
    input.focus();
    return;
  }

  // La vérification part sur le réseau : sans retour visible, l'utilisateur
  // reclique et on enchaîne deux requêtes pour rien.
  save.disabled = true;
  skip.disabled = true;
  setMessage('Vérification auprès de Riot…', 'busy');

  const result = await window.laneform.saveApiKey(key);

  if (result.ok) {
    setMessage('Clé valide, enregistrée. Fermeture…', 'ok');
    setTimeout(() => window.laneform.closeSetup(), 900);
    return;
  }

  setMessage(result.error ?? 'Échec de la vérification.', 'error');
  save.disabled = false;
  skip.disabled = false;
  input.focus();
}

save.addEventListener('click', () => void submit());
skip.addEventListener('click', () => window.laneform.closeSetup());
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void submit();
});

input.focus();
