const form = document.querySelector('#leadForm');
const statusNode = document.querySelector('#formStatus');
const header = document.querySelector('.site-header');

function updateHeader() {
  header.classList.toggle('is-scrolled', window.scrollY > 80);
}

function setStatus(message, type) {
  statusNode.textContent = message;
  statusNode.className = `form-status ${type || ''}`.trim();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  setStatus('Отправляем...', '');

  const payload = new URLSearchParams(new FormData(form));

  try {
    const response = await fetch('/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: payload.toString()
    });

    if (!response.ok) {
      throw new Error('Не удалось отправить заявку.');
    }

    form.reset();
    setStatus('Заявка принята. Скоро свяжемся и подберем ветровое окно.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });
