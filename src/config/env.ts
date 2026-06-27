export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_KEY: process.env.SUPABASE_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  CRM_API_URL: process.env.CRM_API_URL,
  CRM_WEB_INTEGRATION_SECRET: process.env.CRM_WEB_INTEGRATION_SECRET || '',
  /** India INR — falls back to legacy RAZORPAY_KEY_* env names. */
  RAZORPAY_IN_KEY_ID: process.env.RAZORPAY_IN_KEY_ID || process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_IN_KEY_SECRET:
    process.env.RAZORPAY_IN_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_IN_WEBHOOK_SECRET:
    process.env.RAZORPAY_IN_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || '',
  /** Australia (/au/) — Square Web Payments (AUD). */
  SQUARE_APPLICATION_ID: process.env.SQUARE_APPLICATION_ID || '',
  SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN || '',
  SQUARE_LOCATION_ID: process.env.SQUARE_LOCATION_ID || '',
  /** `sandbox` or `production` — inferred from application id when omitted. */
  SQUARE_ENVIRONMENT: (process.env.SQUARE_ENVIRONMENT || '').toLowerCase(),
  CORS_ORIGINS: process.env.CORS_ORIGINS || '',
  PEXELS_API_KEY: process.env.PEXELS_API_KEY || '',
  CMS_MEDIA_BUCKET: process.env.CMS_MEDIA_BUCKET || 'cms-media',
  MADURA_WEB_PUBLIC_URL:
    process.env.MADURA_WEB_PUBLIC_URL ||
    process.env.WEB_PUBLIC_BASE_URL ||
    'https://maduratravel.com',
  SMSINTEGRA_UID: process.env.SMSINTEGRA_UID || '',
  SMSINTEGRA_PWD: process.env.SMSINTEGRA_PWD || '',
  SMSINTEGRA_SID: process.env.SMSINTEGRA_SID || '',
  SMSINTEGRA_ENTITY_ID: process.env.SMSINTEGRA_ENTITY_ID || '',
  SMSINTEGRA_OTP_TEMPLATE_ID: process.env.SMSINTEGRA_OTP_TEMPLATE_ID || '',
  SMSINTEGRA_API_URL: process.env.SMSINTEGRA_API_URL || '',
  PHONE_OTP_PEPPER: process.env.PHONE_OTP_PEPPER || '',
};
