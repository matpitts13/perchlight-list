// Generated with OpenSSL for tests only: a self-signed certificate and the
// RSA signatures (SHA-256 and SHA-1) of the SNS string-to-sign for NOTIFICATION.
// The private key is not kept.
export const CERT_PEM = "-----BEGIN CERTIFICATE-----\r\nMIIDHTCCAgWgAwIBAgIUZWYrdrNPAzpECud7i54AeLw3FZ4wDQYJKoZIhvcNAQEL\r\nBQAwHjEcMBoGA1UEAwwTc25zLnRlc3QucGVyY2hsaWdodDAeFw0yNjExMDkyMzUw\r\nMjlaFw0zNjExMDYyMzUwMjlaMB4xHDAaBgNVBAMME3Nucy50ZXN0LnBlcmNobGln\r\naHQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDWredQKrAabFUepf45\r\nLaw7z8qtXJhqZIPjFxQXYiKwQ93rLl6QojBSb+I7XjmVCco2i8s+Ov47lUx00FUW\r\nh6jHYpoO/1EaTNI0UaeEs97K5WK7+MafAZyfDZTf8CKDCg4laiku+Qq1cSycFDGy\r\nDb9lEkKw7Un9Y79k9QotpH+5cetU+WqEjIdHI2zLTIYkXno71DPziedboqaXIufT\r\nXzHscoicHUsR21ntLuXvA1eBgmkZKdYFAdm3O0peUTwTuTbTC2S1q6Ayx/tJkJDJ\r\ntiZg9whruNdcwpyGtREv6mLn/iwSWPqdZ+iJvoBmB8KvEzyZbqdQQQfJboRjBZDu\r\nnr9fAgMBAAGjUzBRMB0GA1UdDgQWBBS3KChekPFLgw2OinHBuBV+t0cAFDAfBgNV\r\nHSMEGDAWgBS3KChekPFLgw2OinHBuBV+t0cAFDAPBgNVHRMBAf8EBTADAQH/MA0G\r\nCSqGSIb3DQEBCwUAA4IBAQBdowkIBcPgxBWNNIQwPv/PKV+IAis9FUR8bEtbwJYh\r\nDPU5+4owq+PBLUUpMIm0NiO10hGp1ukHZ2PAHHvXhYYnaxcUliI+TMQqLz3ssq4t\r\nuUoQt7VT0Am5QOpkkMQipoclAXtqOgCBAhMarNiPmpPGBw/hh5mg4JrvI5x1W7iA\r\nLfhp315ZJGqw4w1gWNhl5DNxtoOAVR4bmd0eyacv8aKPG04Hmk2WoS8RGj2rre/m\r\nvXphNYPglOtv4q/Tg3R/vX6KSoUJxGf5Pd2qbMgUTQih3Lj5wC4gPFWtuKMlNiea\r\nO34FjWmIQnCmXFFsKTdvZ3qvITCjsS82gg8KkBrh+Gqj\r\n-----END CERTIFICATE-----\r\n";
export const NOTIFICATION = {
  Type: "Notification",
  MessageId: "sns-1",
  TopicArn: "arn:aws:sns:us-east-1:123456789012:perchlight-ses",
  Message: "{\"notificationType\":\"Bounce\",\"bounce\":{\"bounceType\":\"Permanent\",\"bouncedRecipients\":[{\"emailAddress\":\"bounce@example.com\"}]},\"mail\":{\"messageId\":\"ses-msg-1\"}}",
  Timestamp: "2026-11-09T12:00:00.000Z",
  SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem",
};
export const SIGNATURE_SHA256 = "W2ZockTNqoM5v5ENFyXdZbEc3CIUVO1VvNAHI/qFFAOB8D3s64jrsRO0llJUSXUzBIJF2C58Nd7JZ4Mtyu/Xrx1wNGygOyOPyeiotHh2rYZm5PkkzGvP0IFY8NYjULhUdW+8eu8ajPNGUjUz19zGIb7GYQXCN3QKaYxVjiyGuwMyNN9ktKePpjI7XrNs0O9cuhYpZmasYNtfjIQ4pv4sHcmCSaesZS7HNkZxyCeaC+fm+3ENm9OCrtQoKx+apK/WcgFszgciSon2E3QfdtpW0/SMpsLikMA92WUtpkyTBxm+VOAfapGe62MAl+0YYffCanzHV7BrX1n3+/dYjkHBVQ==";
export const SIGNATURE_SHA1 = "SSdYH3L4WJulVhZBYEV4fN+5lQy38MQZlsQZcv74+/hE4ol/ROqVChesRLfNYh3qG+x3zbOs1JyeSRgQHrFnKFmqS/aX++9A7qTtsYAc+r3tpuEJfllH+kL85p7IN86/vKDfecgErQXVvUiP5G5wCwfk7V6NKBC+u0dFkZ1BcaV2yvTP+FhS9dp28ITtQSSMhkYrI4t+g0o1Db5V4cW7ORQag/FMSzTnqd6ITDnlosQSe1JA7GGL6kjvMFATlsQtZBGcvk3estXH+couFvOvooFyXxRj1ejV/MUs+63Gx0fysWHl7gi0qZsFcBnxj15irbtMTc5hE2+fZApqeXU9mg==";
