/* Lead Capture Form — Client-side Logic */
(function () {
  'use strict';

  const form = document.getElementById('lead-form');
  const submitBtn = document.getElementById('submit-btn');
  const errorBanner = document.getElementById('error-banner');
  const successState = document.getElementById('success-state');
  const successTitle = document.getElementById('success-title');
  const successMessage = document.getElementById('success-message');
  const resetBtn = document.getElementById('reset-btn');

  const fields = {
    name: document.getElementById('lead-name'),
    email: document.getElementById('lead-email'),
    phone: document.getElementById('lead-phone'),
    company: document.getElementById('lead-company'),
    message: document.getElementById('lead-message'),
  };

  const errors = {
    name: document.getElementById('name-error'),
    email: document.getElementById('email-error'),
    phone: document.getElementById('phone-error'),
    message: document.getElementById('message-error'),
  };

  /* ── Helpers ──────────────────────────── */
  function showError(field, errorEl) {
    field.classList.add('error');
    errorEl.classList.add('visible');
  }

  function clearError(field, errorEl) {
    field.classList.remove('error');
    errorEl.classList.remove('visible');
  }

  function clearAllErrors() {
    Object.keys(errors).forEach(function (key) {
      clearError(fields[key], errors[key]);
    });
    errorBanner.classList.remove('visible');
    errorBanner.textContent = '';
  }

  function showBanner(message) {
    errorBanner.textContent = message;
    errorBanner.classList.add('visible');
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    if (loading) {
      submitBtn.classList.add('loading');
    } else {
      submitBtn.classList.remove('loading');
    }
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function isValidPhone(phone) {
    // At least 7 digits
    return phone.replace(/\D/g, '').length >= 7;
  }

  /* ── Validation ──────────────────────── */
  function validate() {
    clearAllErrors();
    var valid = true;

    var name = fields.name.value.trim();
    if (!name) {
      showError(fields.name, errors.name);
      valid = false;
    }

    var email = fields.email.value.trim();
    var phone = fields.phone.value.trim();

    if (email && !isValidEmail(email)) {
      showError(fields.email, errors.email);
      valid = false;
    }

    if (phone && !isValidPhone(phone)) {
      showError(fields.phone, errors.phone);
      valid = false;
    }

    // At least one contact method
    if (!email && !phone) {
      showError(fields.email, errors.email);
      showError(fields.phone, errors.phone);
      errors.email.textContent = 'Email or phone is required.';
      errors.phone.textContent = 'Email or phone is required.';
      valid = false;
    }

    var message = fields.message.value.trim();
    if (!message) {
      showError(fields.message, errors.message);
      valid = false;
    }

    return valid;
  }

  /* ── Clear errors on input ───────────── */
  Object.keys(fields).forEach(function (key) {
    fields[key].addEventListener('input', function () {
      if (errors[key]) {
        clearError(fields[key], errors[key]);
      }
      // Also reset the contact hint errors
      if (key === 'email' || key === 'phone') {
        errors.email.textContent = 'Enter a valid email address.';
        errors.phone.textContent = 'Enter a valid phone number.';
      }
    });
  });

  /* ── Submit ──────────────────────────── */
  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!validate()) return;

    var payload = {
      name: fields.name.value.trim(),
      message: fields.message.value.trim(),
    };

    var email = fields.email.value.trim();
    if (email) payload.email = email;

    var phone = fields.phone.value.trim();
    if (phone) payload.phone = phone;

    var company = fields.company.value.trim();
    if (company) payload.company = company;

    setLoading(true);

    fetch('/api/leads/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (result) {
        setLoading(false);

        if (result.data.ok) {
          // Show success
          var firstName = fields.name.value.trim().split(' ')[0];
          successTitle.textContent = 'Thank you, ' + firstName + '!';
          successMessage.textContent =
            "We've received your inquiry and will get back to you shortly.";
          form.style.display = 'none';
          errorBanner.classList.remove('visible');
          successState.classList.add('visible');
        } else {
          showBanner(result.data.error || 'Something went wrong. Please try again.');
        }
      })
      .catch(function () {
        setLoading(false);
        showBanner('Network error. Please check your connection and try again.');
      });
  });

  /* ── Reset ───────────────────────────── */
  resetBtn.addEventListener('click', function () {
    form.reset();
    clearAllErrors();
    successState.classList.remove('visible');
    form.style.display = '';
  });
})();
