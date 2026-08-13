package demo;

class SessionCheck {

  boolean isExpired(long ageMinutes) {
    return ageMinutes > 30;
  }
}
