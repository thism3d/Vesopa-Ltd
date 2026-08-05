let deferredPrompt;
const installPrompt = document.getElementById('installPrompt');
const addToHomeScreenBtn = document.getElementById('addToHomeScreen');
const cancelBtn = document.getElementById('cancelBtn');

// Check if the user has previously cancelled the prompt
const promptCancelled = localStorage.getItem('a2hsPromptCancelled');

// Listen for the beforeinstallprompt event
window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the default install prompt from showing automatically
    e.preventDefault();
    // Store the event for later use
    deferredPrompt = e;

    // Show the custom prompt after 5 seconds only if it was not cancelled before
    if (!promptCancelled) {
        setTimeout(() => {
            installPrompt.classList.add('show');
        }, 5000); // Show after 5 seconds
    }
});

// Handle the button click to show the native install prompt
addToHomeScreenBtn.addEventListener('click', () => {
    // Hide the custom install prompt
    installPrompt.classList.remove('show');

    // Show the deferred install prompt (native)
    if (deferredPrompt) {
        deferredPrompt.prompt();  // Show the install prompt immediately

        // Wait for the user's response
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('User accepted the Vesopa EPOS prompt');
            } else {
                console.log('User dismissed the Vesopa EPOS prompt');
            }
            deferredPrompt = null; // Clear the saved prompt
        });
    }
});

// Handle cancel button click
cancelBtn.addEventListener('click', () => {
    // Hide the custom prompt
    installPrompt.classList.remove('show');
    
    // Store in localStorage to prevent showing again
    localStorage.setItem('a2hsPromptCancelled', 'true');
});
