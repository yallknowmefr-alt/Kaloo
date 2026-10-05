// Kalo settings. The anon key is designed to be public; your data is protected by the
// row-level security rules in supabase.sql. NEVER put the service_role key here.
window.KALO_CONFIG = {
  supabaseUrl: "https://pjffrehtqprwsvnplsrp.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBqZmZyZWh0cXByd3N2bnBsc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNTc5MTMsImV4cCI6MjEwNjYzMzkxM30.d5N3gvd_6heAjJYjXxV7h1svlnBaidhAj9DazwaPFUE",
  googleLogin: true,     // show "Continue with Google" (set up Google in Supabase first)
  requireLogin: true     // false = also allow "Continue as guest"
};
