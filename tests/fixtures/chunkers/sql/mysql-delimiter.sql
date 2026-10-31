-- MySQL migration with a custom delimiter
CREATE TABLE `audit_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `message` varchar(255) DEFAULT 'it\'s; here',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER //

CREATE PROCEDURE log_message(IN msg VARCHAR(255))
BEGIN
  DECLARE n INT DEFAULT 0;
  IF msg IS NULL THEN
    SET n = 1;
  END IF;
  INSERT INTO audit_log (message) VALUES (msg);
END //

CREATE TRIGGER audit_before_insert BEFORE INSERT ON audit_log
FOR EACH ROW
BEGIN
  SET NEW.message = TRIM(NEW.message);
END //

DELIMITER ;

SELECT COUNT(*) FROM audit_log;
