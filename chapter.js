document.addEventListener('DOMContentLoaded', function() {
  // 1. LOAD CONFIGURATION FROM WINDOW (SET IN SQUARESPACE)
  const userConfig = window.CNL_SETTINGS || {};
  
  const CNL_CONFIG = {
    CHAPTER_CODE: userConfig.chapterCode || 'CLT',  
    CHAPTER_CATEGORY: userConfig.category || 'Austin', 
    CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0wq0Bm6gQrgX_Th252L2h9B1GzPQS_SeWg-_JrNi6ynm7CHGcuLw-RjmWC4M5Yg-KMXjvNN0d8ZVe/pub?gid=0&single=true&output=csv',
    EVENTS_SLUG: '/events',
    NO_EVENTS_MSG: "There are no events scheduled for this chapter right now. Sign up for our newsletter to get notified when we announce the next one!"
  };

  const cleanStr = (str) => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

  // --- A. HEADER LOGIC ---
  function initHeader(row) {
    const wrapper = document.getElementById('cnl-header-wrapper');
    const titleEl = document.getElementById('cnl-chapter-title');
    const pillEl = document.getElementById('cnl-social-pill');
    if (!wrapper) return;

    let rawName = row['ChapterName'];
    titleEl.textContent = rawName ? rawName : ("Chapter " + CNL_CONFIG.CHAPTER_CODE);

    const NETWORK_CONFIG = {
      'Twitter':   { type: 'font', value: 'fa-brands fa-x-twitter', label: 'X / Twitter' },
      'Facebook':  { type: 'font', value: 'fa-brands fa-facebook-f', label: 'Facebook' },
      'Instagram': { type: 'font', value: 'fa-brands fa-instagram', label: 'Instagram' },
      'BlueSky':   { type: 'font', value: 'fa-brands fa-bluesky', label: 'Bluesky' },
      'Email':     { type: 'font', value: 'fa-solid fa-envelope', label: 'Email' },
      'Slack':     { type: 'font', value: 'fa-brands fa-slack', label: 'Slack' },
      'WhatsApp':  { type: 'font', value: 'fa-brands fa-whatsapp', label: 'WhatsApp' },
      'Discord':   { type: 'font', value: 'fa-brands fa-discord', label: 'Discord' },
      'GroupMe':   { type: 'svg',  value: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm4.639 5.865a1.85 1.85 0 1 1-3.699.001 1.85 1.85 0 0 1 3.699-.001zm-9.333.055h2.95v9.846h-2.95V5.92zm4.567 12.16H5.216v-1.129h6.602l.003-8.625h2.95v8.652c0 1.258-1.536 1.082-2.953 1.102z"/></svg>', label: 'GroupMe' }
    };

    const columns = ['Twitter', 'Facebook', 'Instagram', 'BlueSky', 'Email', 'Slack', 'WhatsApp', 'GroupMe', 'Discord'];
    let iconCount = 0;

    columns.forEach(network => {
      let link = row[network];
      if (NETWORK_CONFIG[network] && link && link.trim() !== '') {
        link = link.trim();
        if (network === 'Email' && !link.startsWith('mailto:')) link = 'mailto:' + link;
        else if (!link.startsWith('http') && !link.startsWith('mailto:')) link = 'https://' + link;

        const a = document.createElement('a');
        a.href = link;
        a.className = 'cnl-pill-link';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        
        let iconHTML = NETWORK_CONFIG[network].type === 'font' 
          ? `<i class="${NETWORK_CONFIG[network].value}"></i>` 
          : NETWORK_CONFIG[network].value;

        a.innerHTML = `${iconHTML}<span class="cnl-tooltip">${NETWORK_CONFIG[network].label}</span>`;
        pillEl.appendChild(a);
        iconCount++;
      }
    });

    if (iconCount === 0) pillEl.style.display = 'none';
    setTimeout(() => wrapper.classList.add('cnl-loaded'), 100);
  }

  // --- B. FORM LOGIC ---
  function initForm(row) {
    const rawLink = row['EveryAction Link'];
    const EMBED_BASE = 'https://secure.everyaction.com/v1/Forms/';
    const containerWrapper = document.getElementById('ea-glass-card'); 
    const formContainer = document.querySelector('.cnl-ea-form-wrap');
    
    if (!formContainer) return;

    if (rawLink && rawLink.trim() !== '') {
      const cleanLink = rawLink.trim().replace(/\/$/, "");
      const slug = cleanLink.substring(cleanLink.lastIndexOf('/') + 1);
      const finalEmbedUrl = EMBED_BASE + slug;

      const formDiv = document.createElement('div');
      formDiv.className = 'ngp-form';
      formDiv.setAttribute('data-form-url', finalEmbedUrl);
      formDiv.setAttribute('data-fastaction-endpoint', 'https://fastaction.ngpvan.com');
      formDiv.setAttribute('data-inline-errors', 'true');
      formDiv.setAttribute('data-fastaction-nologin', 'true');
      formDiv.setAttribute('data-databag-endpoint', 'https://profile.ngpvan.com');
      formDiv.setAttribute('data-databag', 'everybody');
      formDiv.setAttribute('data-mobile-autofocus', 'false');

      formContainer.innerHTML = ''; 
      formContainer.appendChild(formDiv);

      document.querySelectorAll('script[src*="ea-actiontag/at.js"]').forEach(s => s.remove());
      const script = document.createElement('script');
      script.src = 'https://static.everyaction.com/ea-actiontag/at.js';
      script.crossOrigin = 'anonymous';
      script.src += '?t=' + new Date().getTime(); 
      document.body.appendChild(script);

      setTimeout(() => containerWrapper.classList.add('is-loaded'), 200);

    } else {
      formContainer.innerHTML = `<p style="text-align:center; color:#FDFBE9; padding:20px;">Join link not configured.</p>`;
      containerWrapper.classList.add('is-loaded');
    }
  }

  // --- C. EVENTS LOGIC ---
  function initEvents() {
    const container = document.getElementById('cnl-events-feed');
    const fetchUrl = `${CNL_CONFIG.EVENTS_SLUG}?format=json`;

    fetch(fetchUrl)
      .then(r => r.json())
      .then(data => {
        const now = Date.now();
        let allItems = [];
        if (data.upcoming) allItems = allItems.concat(data.upcoming);
        if (data.items) allItems = allItems.concat(data.items);
        
        allItems = allItems.filter((v,i,a)=>a.findIndex(t=>(t.id === v.id))===i);
        const targetCategory = cleanStr(CNL_CONFIG.CHAPTER_CATEGORY);

        const validEvents = allItems.filter(item => {
          if (item.startDate < now) return false;
          if (!item.categories) return false;
          return item.categories.some(cat => cleanStr(cat) === targetCategory);
        });

        container.innerHTML = ''; 

        if (validEvents.length === 0) {
          container.innerHTML = `
            <div class="cnl-event-card cnl-empty-state">
              <div class="cnl-empty-icon"><i class="fa-regular fa-calendar-xmark"></i></div>
              <h3 class="cnl-event-title">No Upcoming Events</h3>
              <p class="cnl-event-details">${CNL_CONFIG.NO_EVENTS_MSG}</p>
            </div>`;
          setTimeout(() => document.querySelector('.cnl-event-card').classList.add('cnl-loaded'), 50);
        } else {
          validEvents.forEach((event, index) => {
            const card = createEventCard(event);
            container.appendChild(card);
            setTimeout(() => card.classList.add('cnl-loaded'), index * 100);
          });
        }
      })
      .catch(err => {
        console.error(err);
        container.innerHTML = '<p class="cnl-error-msg">Unable to load events.</p>';
      });
  }

  function createEventCard(item) {
    const date = new Date(item.startDate);
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute:'2-digit' });
    
    let location = "Location TBD";
    if(item.location && item.location.addressTitle) location = item.location.addressTitle;
    else if (item.structuredContent?.location?.addressTitle) location = item.structuredContent.location.addressTitle;

    const card = document.createElement('div');
    card.className = 'cnl-event-card';
    card.innerHTML = `
      <div class="cnl-date-badge">
        <span class="cnl-ed-month">${months[date.getMonth()]}</span>
        <span class="cnl-ed-day">${date.getDate()}</span>
      </div>
      <div class="cnl-event-content">
        <h3 class="cnl-event-title"><a href="${item.fullUrl}" target="_blank">${item.title}</a></h3>
        <div class="cnl-event-meta"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
        <div class="cnl-event-meta"><i class="fa-solid fa-location-dot"></i> ${location}</div>
        <a href="${item.fullUrl}" target="_blank" class="cnl-rsvp-btn">RSVP & Details</a>
      </div>
    `;
    return card;
  }

  Papa.parse(CNL_CONFIG.CSV_URL, {
    download: true, header: true,
    complete: function(results) {
      const chapterData = results.data.find(row => row['ChapterCode'] && row['ChapterCode'].trim() === CNL_CONFIG.CHAPTER_CODE);
      if (chapterData) { initHeader(chapterData); initForm(chapterData); }
      else { document.getElementById('cnl-chapter-title').textContent = "Chapter Not Found"; }
    }
  });
  initEvents();
});