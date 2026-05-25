/**
 * Overlay Renderer Process
 */

const overlayTextEl = document.getElementById('overlayText');
const closeBtn = document.getElementById('closeOverlayBtn');

// Listen for text updates from the main process
window.electronAPI.onUpdateOverlayText((text) => {
  if (text) {
    overlayTextEl.textContent = text;
  } else {
    overlayTextEl.innerHTML = '<i>Waiting for translation...</i>';
  }
});

// Close button functionality
closeBtn.addEventListener('click', () => {
  window.electronAPI.toggleOverlay(); // Tell main process to hide it
});
