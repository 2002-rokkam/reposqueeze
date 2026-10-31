/* Stored procedures for the reporting database */
USE reporting;
GO

CREATE PROCEDURE dbo.usp_GetOrderTotals
    @CustomerId INT
AS
BEGIN
    SET NOCOUNT ON;

    SELECT CustomerId, SUM(Total) AS Total
    FROM dbo.Orders
    WHERE CustomerId = @CustomerId
    GROUP BY CustomerId;
END
GO

CREATE FUNCTION dbo.fn_TaxRate (@Country NVARCHAR(2))
RETURNS DECIMAL(5, 2)
AS
BEGIN
    DECLARE @rate DECIMAL(5, 2) = CASE @Country WHEN 'DE' THEN 19.0 WHEN 'FR' THEN 20.0 ELSE 0 END;
    RETURN @rate;
END
GO

SELECT [Name], [Id] FROM [dbo].[Customers] WHERE [Name] LIKE 'O''Brien%';
GO
