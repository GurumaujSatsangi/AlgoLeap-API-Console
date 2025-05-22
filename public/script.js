// This script adds interactivity to the Google Cloud Console UI

document.addEventListener('DOMContentLoaded', function() {
    // Add click event for menu button
    const menuBtn = document.querySelector('.menu-btn');
    menuBtn.addEventListener('click', function() {
        console.log('Menu button clicked');
        // In a real implementation, this would toggle a sidebar
    });
    
    // Add click event for project selector
    const projectBtn = document.querySelector('.project-btn');
    projectBtn.addEventListener('click', function() {
        console.log('Project selector clicked');
        // In a real implementation, this would open a project dropdown
    });
    
    // Add click events for copy buttons
    const copyBtns = document.querySelectorAll('.copy-btn');
    copyBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const textToCopy = this.previousElementSibling.textContent;
            navigator.clipboard.writeText(textToCopy)
                .then(() => {
                    console.log('Text copied to clipboard');
                    // Show a temporary tooltip or notification
                    const originalIcon = this.innerHTML;
                    this.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => {
                        this.innerHTML = originalIcon;
                    }, 2000);
                })
                .catch(err => {
                    console.error('Failed to copy text: ', err);
                });
        });
    });
    
    // Add hover effects for cards
    const cards = document.querySelectorAll('.action-card, .access-card');
    cards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.backgroundColor = '#f8f9fa';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.backgroundColor = '';
        });
    });
    
    // Add click event for tabs
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function(e) {
            e.preventDefault();
            // Remove active class from all tabs
            tabs.forEach(t => t.classList.remove('active'));
            // Add active class to clicked tab
            this.classList.add('active');
        });
    });
    
    // Add click event for Gemini options
    const geminiOptions = document.querySelectorAll('.gemini-option');
    geminiOptions.forEach(option => {
        option.addEventListener('click', function() {
            console.log('Gemini option clicked:', this.textContent.trim());
            // In a real implementation, this would navigate to Gemini
        });
    });
    
    // Add click event for view all products button
    const viewAllBtn = document.querySelector('.view-all-btn');
    viewAllBtn.addEventListener('click', function() {
        console.log('View all products clicked');
        // In a real implementation, this would navigate to products page
    });
    
    // Replace Font Awesome placeholder with actual icons
    // Note: In a real implementation, you would include the Font Awesome library
    // This is a workaround since we can't include external libraries
    replaceIcons();
});

function replaceIcons() {
    // Replace menu icon
    document.querySelector('.menu-btn i').innerHTML = '☰';
    
    // Replace project icon
    document.querySelector('.project-btn i').innerHTML = '◧';
    
    // Replace search icon
    document.querySelector('.search-btn i').innerHTML = '🔍';
    
    // Replace header icons
    const headerIcons = document.querySelectorAll('.header-right .icon-btn i');
    const headerIconsReplacements = ['★', '🎁', '🔔', '?', '⋮'];
    headerIcons.forEach((icon, index) => {
        if (headerIconsReplacements[index]) {
            icon.innerHTML = headerIconsReplacements[index];
        }
    });
    
    // Replace copy icons
    document.querySelectorAll('.copy-btn i').forEach(icon => {
        icon.innerHTML = '📋';
    });
    
    // Replace action card icons
    document.querySelectorAll('.action-card i').forEach(icon => {
        icon.innerHTML = '+';
    });
    
    // Replace arrow icon
    document.querySelector('.gemini-option.with-arrow i').innerHTML = '→';
    
    // Replace access card icons
    const accessIcons = document.querySelectorAll('.access-card i');
    const accessIconsReplacements = ['⚙️', '🔒', '💳', '🖥️', '💾', '🔍', '🌐', '📦'];
    accessIcons.forEach((icon, index) => {
        if (accessIconsReplacements[index]) {
            icon.innerHTML = accessIconsReplacements[index];
        }
    });
    
    // Replace view all icon
    document.querySelector('.view-all-btn i').innerHTML = '◫';
}